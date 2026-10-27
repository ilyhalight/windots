/**
 * Pure TPS math: token estimation, sliding-window rate, per-response bookkeeping and
 * reconciliation with the real usage reported by `session.step.ended`.
 *
 * Every timestamp is in milliseconds on ONE clock and is passed in by the caller, so nothing
 * here reads the wall clock and everything is deterministic under test.
 */

/** Sliding window for the live rate. Deltas arrive in ~100 ms chunks, so this spans ~15–18 chunks. */
export const WINDOW_MS = 1800
/** Sparkline sampling period. 24 samples at 250 ms show the last ~6 s. */
export const SAMPLE_EVERY_MS = 250
export const MAX_SAMPLES = 24
/** Below this much generation time an average is noise, not a rate. */
const MIN_AVG_MS = 250
/** The live rate never divides by less than this, so the first chunks cannot spike it. */
const MIN_SPAN_MS = 500
/** A peak needs at least this much step history to mean anything. */
const MIN_PEAK_MS = 1000
const MAX_TRACKED_STEPS = 64

// ---------------------------------------------------------------------------
// Token estimation (no tokenizer). Characters per token by script:
//   CJK / kana / hangul        1.0   about one token per character
//   Cyrillic letters           2.8   BPE vocabularies are less dense for it than for Latin
//   other non-ASCII            2.0   accents, Greek, Arabic, emoji and the like
//   other ASCII (non-space)    4.5   Latin text, digits, punctuation, code
//   whitespace                 20    cheap: BPE merges it into the neighbouring token
// "The quick brown fox" (4 tokens) estimates at 3.7. The estimate only drives the live display;
// `session.step.ended` replaces it with the provider's real count.
// ---------------------------------------------------------------------------
const CJK_CHARS_PER_TOKEN = 1
const CYRILLIC_CHARS_PER_TOKEN = 2.8
const OTHER_CHARS_PER_TOKEN = 2
const ASCII_CHARS_PER_TOKEN = 4.5
const SPACE_CHARS_PER_TOKEN = 20

function isCjk(code: number): boolean {
  return (
    (code >= 0x3040 && code <= 0x30ff) || // hiragana, katakana
    (code >= 0x3400 && code <= 0x4dbf) || // CJK extension A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK unified
    (code >= 0xac00 && code <= 0xd7af) || // hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility
    (code >= 0x20000 && code <= 0x2fa1f) // CJK extensions B–F
  )
}

function isCyrillic(code: number): boolean {
  return (code >= 0x0400 && code <= 0x052f) || (code >= 0x1c80 && code <= 0x1c8f)
}

/** Fractional token estimate for a streamed text chunk. */
export function estimateTokens(text: string): number {
  let tokens = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i)!
    if (code > 0xffff) i++ // surrogate pair
    if (code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09) tokens += 1 / SPACE_CHARS_PER_TOKEN
    else if (code < 0x80) tokens += 1 / ASCII_CHARS_PER_TOKEN
    else if (isCjk(code)) tokens += 1 / CJK_CHARS_PER_TOKEN
    else if (isCyrillic(code)) tokens += 1 / CYRILLIC_CHARS_PER_TOKEN
    else tokens += 1 / OTHER_CHARS_PER_TOKEN
  }
  return tokens
}

// ---------------------------------------------------------------------------
// Reconciliation with real usage
// ---------------------------------------------------------------------------
export interface StepUsage {
  readonly output: number
  readonly reasoning: number
}

const ratio = (a: number, b: number) => (a > b ? a / b : b / a)

/**
 * Real generated tokens for one step, or undefined when the provider reported none.
 * Normally `output + reasoning` (reasoning is reported separately and we count its deltas too).
 * If that sum is more than 3x away from what was streamed while `output` alone is within 1.5x,
 * the provider evidently already includes reasoning in `output`, so `output` alone is used.
 */
export function reconcileTokens(estimated: number, usage: StepUsage): number | undefined {
  const output = Math.max(0, usage.output)
  const sum = output + Math.max(0, usage.reasoning)
  if (sum <= 0) return undefined
  if (estimated > 0 && output > 0 && ratio(sum, estimated) > 3 && ratio(output, estimated) <= 1.5) return output
  return sum
}

// ---------------------------------------------------------------------------
// Meter
// ---------------------------------------------------------------------------
/**
 * waiting   response requested, no token yet
 * streaming the model is producing tokens
 * paused    between steps (tools running); the clock is stopped
 * done      response finished
 */
export type Phase = "waiting" | "streaming" | "paused" | "done"

export interface Snapshot {
  readonly phase: Phase
  /** Sliding-window rate; 0 unless streaming. */
  readonly tps: number
  /** Tokens / generation time over the whole response; 0 while there is too little data. */
  readonly avg: number
  readonly peak: number
  readonly tokens: number
  /** True when every counted step was reconciled with the provider's real usage. */
  readonly exact: boolean
  /** Time to first token in ms, when known. */
  readonly ttftMs?: number
  /** How long the first token has been awaited; only while `ttftMs` is still unknown. */
  readonly waitMs?: number
  /** Time spent generating (tools and gaps excluded), ms. */
  readonly genMs: number
  /** Recent live-rate samples for the sparkline, oldest first. */
  readonly samples: readonly number[]
}

interface Step {
  firstAt?: number
  /** Estimated tokens streamed so far. */
  tokens: number
  /** Chunks inside the window. The first chunk is left out: it only starts the clock. */
  window: { t: number; n: number }[]
  /** What this step currently contributes to the response totals. */
  counted: number
  /** Real usage has been applied (or deliberately skipped). */
  reconciled: boolean
}

interface Response {
  startedAt: number
  active: boolean
  tokens: number
  /** Sum of the estimates behind `tokens`, to scale the peak after reconciliation. */
  estimated: number
  genMs: number
  /** Steps with counted tokens that still rest on an estimate. */
  unreconciled: number
  peak: number
  ttftMs?: number
  /** Request time of the step that is, or will be, the first with output. */
  requestedAt?: number
  samples: number[]
  lastSampleAt: number
}

export class Meter {
  private response: Response | undefined
  private step: { id: string; data: Step } | undefined
  private readonly closed = new Map<string, Step>()

  /** True while a response is in progress (between execution start and end). */
  get active(): boolean {
    return this.response?.active === true
  }

  /** True while something time-dependent is on screen: waiting for a token or streaming one. */
  get ticking(): boolean {
    return this.active && (this.step?.data.firstAt !== undefined || this.waiting)
  }

  private get waiting(): boolean {
    return this.response !== undefined && this.response.tokens === 0 && this.step?.data.firstAt === undefined
  }

  executionStarted(at: number): void {
    this.closed.clear()
    this.step = undefined
    this.response = {
      startedAt: at,
      active: true,
      tokens: 0,
      estimated: 0,
      genMs: 0,
      unreconciled: 0,
      peak: 0,
      samples: [],
      lastSampleAt: 0,
    }
  }

  /** `requestedAt` is `session.step.started`'s `started`: the moment the request was sent. */
  stepStarted(at: number, messageID: string, requestedAt: number = at): void {
    const response = this.ensureResponse(at)
    this.closeStep(at)
    // Until a token has arrived, a newer step (a retry) supersedes the earlier request time.
    if (response.ttftMs === undefined) response.requestedAt = requestedAt
    this.step = { id: messageID, data: this.newStep() }
  }

  /** Streamed generated text: answer or reasoning. Tool-call arguments are deliberately not fed in. */
  delta(at: number, messageID: string, text: string): void {
    const response = this.ensureResponse(at)
    if (this.step?.id !== messageID) {
      this.closeStep(at)
      this.step = { id: messageID, data: this.newStep() }
    }
    const step = this.step!.data
    const n = estimateTokens(text)
    if (n <= 0) return
    if (step.firstAt === undefined) {
      step.firstAt = at
      if (response.ttftMs === undefined) {
        response.ttftMs = Math.max(0, at - (response.requestedAt ?? response.startedAt))
      }
    } else {
      step.window.push({ t: at, n })
    }
    step.tokens += n
    this.prune(step, at)
    if (at - step.firstAt >= MIN_PEAK_MS) response.peak = Math.max(response.peak, this.rate(step, at))
  }

  /** The model stopped generating this step (tools may still run). Stops the clock. */
  stepStreamed(at: number, messageID: string): void {
    if (this.step?.id === messageID) this.closeStep(at)
  }

  /** Real usage arrived: it replaces the estimate for this step. */
  stepEnded(at: number, messageID: string, usage: StepUsage | undefined): void {
    if (this.step?.id === messageID) this.closeStep(at)
    const response = this.response
    const step = this.closed.get(messageID)
    if (!response || !step || step.reconciled) return
    step.reconciled = true
    // A step that streamed nothing has no generation time, so its tokens would only inflate the average.
    if (step.counted === 0) return
    const exact = usage ? reconcileTokens(step.tokens, usage) : undefined
    if (exact === undefined) return
    response.tokens += exact - step.counted
    response.unreconciled--
    step.counted = exact
  }

  /** Drop the unfinished step without counting it (the request is being retried). */
  stepDiscarded(): void {
    this.step = undefined
  }

  executionEnded(at: number): void {
    if (!this.response) return
    this.closeStep(at)
    this.response.active = false
  }

  /** Record a sparkline sample. Call at the UI tick rate; it throttles itself. */
  sample(at: number): void {
    const response = this.response
    const step = this.step?.data
    if (!response || !step || step.firstAt === undefined) return
    if (at - response.lastSampleAt < SAMPLE_EVERY_MS) return
    response.lastSampleAt = at
    response.samples.push(this.rate(step, at))
    if (response.samples.length > MAX_SAMPLES) response.samples.shift()
  }

  snapshot(now: number): Snapshot | undefined {
    const response = this.response
    if (!response) return undefined
    // The open step is the one still generating; closed steps are already folded into the response.
    const step = this.step?.data
    const live = step?.firstAt !== undefined ? step : undefined

    const tokens = response.tokens + (step?.tokens ?? 0)
    const genMs = response.genMs + (live ? Math.max(0, now - live.firstAt!) : 0)
    const phase: Phase = !response.active ? "done" : live ? "streaming" : tokens > 0 ? "paused" : "waiting"
    if (phase === "done" && tokens <= 0) return undefined

    // After reconciliation the estimated peak is scaled by the same factor as the totals.
    const scale = phase === "done" && response.estimated > 0 ? response.tokens / response.estimated : 1
    return {
      phase,
      tps: live ? this.rate(live, now) : 0,
      avg: genMs >= MIN_AVG_MS ? tokens / (genMs / 1000) : 0,
      peak: response.peak * scale,
      tokens,
      exact: response.unreconciled === 0 && !live,
      ttftMs: response.ttftMs,
      waitMs:
        response.ttftMs === undefined && response.active
          ? Math.max(0, now - (response.requestedAt ?? response.startedAt))
          : undefined,
      genMs,
      samples: response.samples,
    }
  }

  // -- internals ------------------------------------------------------------

  private newStep(): Step {
    return { tokens: 0, window: [], counted: 0, reconciled: false }
  }

  /** A delta with no preceding execution event (plugin loaded mid-response) starts a response lazily. */
  private ensureResponse(at: number): Response {
    if (!this.response || !this.response.active) this.executionStarted(at)
    return this.response!
  }

  /** Stop the clock for the current step and fold it into the response totals. */
  private closeStep(at: number): void {
    const current = this.step
    const response = this.response
    if (!current || !response) return
    this.step = undefined
    const step = current.data
    if (step.tokens > 0 && step.firstAt !== undefined) {
      response.genMs += Math.max(0, at - step.firstAt)
      response.tokens += step.tokens
      response.estimated += step.tokens
      response.unreconciled++
      step.counted = step.tokens
    }
    this.closed.set(current.id, step)
    if (this.closed.size > MAX_TRACKED_STEPS) this.closed.delete(this.closed.keys().next().value!)
  }

  private prune(step: Step, now: number): void {
    const cutoff = now - WINDOW_MS
    let drop = 0
    while (drop < step.window.length && step.window[drop]!.t <= cutoff) drop++
    if (drop > 0) step.window.splice(0, drop)
  }

  /** Tokens/second over the trailing window. */
  private rate(step: Step, now: number): number {
    if (step.firstAt === undefined) return 0
    const cutoff = now - WINDOW_MS
    let sum = 0
    for (const entry of step.window) if (entry.t > cutoff) sum += entry.n
    const span = Math.max(MIN_SPAN_MS, Math.min(WINDOW_MS, now - step.firstAt))
    return sum / (span / 1000)
  }
}
