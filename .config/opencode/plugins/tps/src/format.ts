/** Pure display helpers: no theme, no renderer, no clock. */

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const
/** Static glyph shown while the model is not generating (tools running). */
export const SPINNER_IDLE = "⠶"
const BARS = "▁▂▃▄▅▆▇█"

/** Width of the live rate column, so the sparkline next to it does not shift. */
export const RATE_WIDTH = 4
/** The sparkline never scales below this, so a trickle of 2 tok/s does not fill the whole bar. */
const MIN_SCALE = 10

/** 842 -> "842", 1234 -> "1.2k", 12_345 -> "12k", 1_234_567 -> "1.2M". */
export function formatTokens(value: number): string {
  const n = Math.max(0, Math.round(value))
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** 800 -> "0.8s", 14_120 -> "14.1s", 65_000 -> "1m05s". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, ms) / 1000
  if (total < 59.95) return `${total.toFixed(1)}s`
  const minutes = Math.floor(total / 60)
  const seconds = Math.round(total - minutes * 60)
  return seconds === 60 ? `${minutes + 1}m00s` : `${minutes}m${String(seconds).padStart(2, "0")}s`
}

/** Rate as a fixed-width string: " 9.4", "  87", " 412". */
export function formatRate(tps: number): string {
  const text = tps < 9.95 ? Math.max(0, tps).toFixed(1) : String(Math.round(tps))
  return text.padStart(RATE_WIDTH)
}

/** Rounded rate for summaries: "87", "9.4". */
export function formatAverage(tps: number): string {
  return tps < 9.95 ? tps.toFixed(1) : String(Math.round(tps))
}

/** Marks the subagents working while the main model is not generating. */
export const SUBAGENT_GLYPH = "⑂"

/** "⑂ 1 subagent", "⑂ 2 subagents"; compact: "⑂2". */
export function formatSubagents(count: number, compact: boolean): string {
  if (compact) return `${SUBAGENT_GLYPH}${count}`
  return `${SUBAGENT_GLYPH} ${count} ${count === 1 ? "subagent" : "subagents"}`
}

export interface Bar {
  readonly glyph: string
  /** The sample behind the glyph, for colouring by speed. */
  readonly value: number
}

/** The latest `width` samples as bars, scaled to the largest of them (at least MIN_SCALE). */
export function sparkline(samples: readonly number[], width: number): Bar[] {
  const visible = samples.slice(-width)
  const scale = Math.max(MIN_SCALE, ...visible)
  return visible.map((value) => {
    const level = Math.round((Math.max(0, value) / scale) * (BARS.length - 1))
    return { glyph: BARS[Math.min(BARS.length - 1, level)]!, value }
  })
}
