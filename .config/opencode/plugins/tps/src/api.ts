/**
 * The small public surface other plugins can read: `globalThis[Symbol.for("opencode.tps")]`.
 *
 * Plain data in, plain data out, no shared module instances: a consumer needs neither this package nor
 * the same solid-js. It reads a snapshot on its own tick and renders it however it likes; everything it
 * would otherwise duplicate (speed tier, sparkline glyphs, rounded numbers, spinner frame) is in here.
 * Bump `version` on any breaking change; consumers should check it.
 */
import { formatAverage, formatDuration, formatRate, formatTokens, SPINNER, SPINNER_IDLE, sparkline } from "./format.ts"
import type { Phase, Snapshot } from "./meter.ts"

export const API_KEY = Symbol.for("opencode.tps")
export const API_VERSION = 1

/** Speed tiers in tokens/second: below SLOW is `slow`, from FAST is `fast`, in between is `normal`. */
export const SLOW_TPS = 20
export const FAST_TPS = 60
/** Bars in `TpsSnapshot.bars`. A narrow consumer takes the last few. */
export const API_SPARK_WIDTH = 16

export type Tier = "slow" | "normal" | "fast"

export function tierOf(tps: number): Tier {
  return tps >= FAST_TPS ? "fast" : tps >= SLOW_TPS ? "normal" : "slow"
}

export interface TpsBar {
  readonly glyph: string
  readonly tier: Tier
}

export interface TpsSnapshot {
  /** waiting: no token yet · streaming: generating · paused: between steps (tools running) · done: finished. */
  readonly phase: Phase
  /** Agent that produced the response, when known. */
  readonly agent?: string
  /** Live rate over the last ~2 s; 0 unless streaming. */
  readonly tps: number
  readonly tier: Tier
  /** Tokens / generation time over the response; 0 while there is too little data. */
  readonly avg: number
  readonly peak: number
  readonly tokens: number
  /** False while the counts still contain estimates; `approx` is the matching prefix. */
  readonly exact: boolean
  readonly approx: "" | "≈"
  readonly ttftMs?: number
  /** How long the first token has been awaited; only while it has not arrived. */
  readonly waitMs?: number
  readonly genMs: number
  /** Recent live-rate samples, oldest first. */
  readonly samples: readonly number[]
  /** `samples` as bar glyphs (latest `API_SPARK_WIDTH`), each with its own tier. */
  readonly bars: readonly TpsBar[]
  /** The glyphs of `bars` as one string. */
  readonly spark: string
  /** Braille frame for this moment: turning while waiting or streaming, a still glyph otherwise. */
  readonly spinner: string
  /** Display strings. `rate` is padded to a fixed width; the rest are not. */
  readonly text: {
    readonly rate: string
    readonly avg: string
    readonly peak: string
    readonly tokens: string
    readonly ttft?: string
    readonly gen: string
    readonly wait?: string
  }
}

export interface TpsApi {
  readonly version: typeof API_VERSION
  /** Latest state of a session's current (or last) response; undefined when nothing was measured. */
  snapshot(sessionID: string): TpsSnapshot | undefined
}

/** `clock` is wall-clock milliseconds; it only picks the spinner frame. */
export function toTpsSnapshot(snapshot: Snapshot, clock: number, agent?: string): TpsSnapshot {
  const moving = snapshot.phase === "waiting" || snapshot.phase === "streaming"
  const bars = sparkline(snapshot.samples, API_SPARK_WIDTH).map((bar) => ({ glyph: bar.glyph, tier: tierOf(bar.value) }))
  const approx = snapshot.exact ? "" : "≈"
  return {
    phase: snapshot.phase,
    ...(agent === undefined ? {} : { agent }),
    tps: snapshot.tps,
    tier: tierOf(snapshot.tps),
    avg: snapshot.avg,
    peak: snapshot.peak,
    tokens: snapshot.tokens,
    exact: snapshot.exact,
    approx,
    ...(snapshot.ttftMs === undefined ? {} : { ttftMs: snapshot.ttftMs }),
    ...(snapshot.waitMs === undefined ? {} : { waitMs: snapshot.waitMs }),
    genMs: snapshot.genMs,
    samples: [...snapshot.samples],
    bars,
    spark: bars.map((bar) => bar.glyph).join(""),
    spinner: moving ? SPINNER[Math.floor(clock / 100) % SPINNER.length]! : SPINNER_IDLE,
    text: {
      rate: formatRate(snapshot.tps),
      avg: formatAverage(snapshot.avg),
      peak: formatAverage(snapshot.peak),
      tokens: formatTokens(snapshot.tokens),
      ...(snapshot.ttftMs === undefined ? {} : { ttft: formatDuration(snapshot.ttftMs) }),
      gen: formatDuration(snapshot.genMs),
      ...(snapshot.waitMs === undefined ? {} : { wait: formatDuration(snapshot.waitMs) }),
    },
  }
}

/**
 * Make `api` the current one. The returned function removes it, but only if it is still the current one,
 * so a reloaded generation that already replaced it is left alone.
 */
export function publish(api: TpsApi, host: object = globalThis): () => void {
  const slots = host as Record<symbol, unknown>
  slots[API_KEY] = api
  return () => {
    if (slots[API_KEY] === api) delete slots[API_KEY]
  }
}
