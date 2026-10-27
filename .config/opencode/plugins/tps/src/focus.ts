/**
 * What the main footer line reports while the main model is not generating.
 *
 *   none    nothing to add: the model streams, the response is over, or no subagent is working
 *   solo    exactly one subagent is working and has live data: show its speed
 *   marker  otherwise (several subagents, or one with nothing measured yet): just count them
 */
import type { Phase } from "./meter.ts"

export type Focus =
  | { readonly kind: "none" }
  | { readonly kind: "solo"; readonly id: string }
  | { readonly kind: "marker"; readonly count: number }

const NONE: Focus = { kind: "none" }

/** `measured(id)`: whether the subagent has a speed worth showing (a meter with a response in progress). */
export function chooseFocus(phase: Phase, busy: readonly string[], measured: (id: string) => boolean): Focus {
  if (phase !== "paused" && phase !== "waiting") return NONE
  const [only, ...rest] = busy
  if (only === undefined) return NONE
  if (rest.length === 0 && measured(only)) return { kind: "solo", id: only }
  return { kind: "marker", count: busy.length }
}
