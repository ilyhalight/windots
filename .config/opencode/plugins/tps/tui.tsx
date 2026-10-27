/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import type { RGBA } from "@opentui/core"
import { createMemo, createSignal, Index, Show, type Accessor } from "solid-js"
import { publish, tierOf, toTpsSnapshot, type Tier } from "./src/api.ts"
import { Family, STALE_MS, type Host } from "./src/family.ts"
import { chooseFocus } from "./src/focus.ts"
import {
  formatAverage,
  formatDuration,
  formatRate,
  formatSubagents,
  formatTokens,
  SPINNER,
  SPINNER_IDLE,
  SUBAGENT_GLYPH,
  sparkline,
} from "./src/format.ts"
import { Meter, type Snapshot } from "./src/meter.ts"

const TICK_MS = 100
/** Bars shown next to the live rate (the meter keeps a few more samples than this). */
const SPARK_WIDTH = 16
/** Subagents and their children each need a meter while they work; this is generous for parallel fan-out. */
const MAX_METERS = 64
const MAX_AGENT_NAME = 16

interface Settings {
  visible: boolean
  mode: "full" | "compact"
}

interface Entry {
  readonly meter: Meter
  /** Local time of the last event for this session. */
  touched: number
  /** Agent of the latest step (`session.step.started`). */
  agent?: string
}

interface Segment {
  readonly text: string
  readonly fg: RGBA
}

/**
 * What the footer line shows: the displayed session's meter and, while its model is idle, either the speed of
 * its single working subagent or a count of several.
 */
interface View {
  readonly snapshot: Snapshot
  /** Busy descendants; only counted while the main model is not generating. */
  readonly subagents: number
  /** Set when exactly one subagent is working and has a meter: its state is shown instead of the count. */
  readonly solo?: { readonly name: string; readonly snapshot: Snapshot }
}

export default Plugin.define({
  id: "tps",
  setup(context) {
    const [settings, updateSettings] = context.storage.store<Settings>("settings", {
      initial: { visible: true, mode: "full" },
    })

    const entries = new Map<string, Entry>()
    // Parent links and busy state of every session seen, to count the subagents under the displayed one.
    const family = new Family()
    // The host's own session cache fills in what events did not tell us (e.g. the plugin loaded mid-run).
    // It is a fallback only, so a lookup that throws is treated as "unknown".
    const guard = <T,>(fallback: T, read: () => T): T => {
      try {
        return read()
      } catch {
        return fallback
      }
    }
    const host: Host = {
      parent: (id) => guard(undefined, () => context.data.session.get(id)?.parentID),
      busy: (id) => guard(false, () => context.data.session.status(id) === "running"),
      members: (root) => guard([], () => context.data.session.family(root)),
    }
    const subagentsUnder = (sessionID: string) => family.count(sessionID, Date.now(), host)
    // Bumped on every tick and every event, so views re-read the (non-reactive) meters.
    const [version, setVersion] = createSignal(0)
    // Only the timer advances the spinner, so it moves at a steady pace however busy the stream is.
    const [frame, setFrame] = createSignal(0)
    let timer: ReturnType<typeof setInterval> | undefined

    // Meters work on the server's event timestamps. `skew` maps the local clock onto them: it follows the
    // lowest delivery delay seen, which makes a remote server's clock offset irrelevant.
    let skew: number | undefined
    const stamp = (created: number) => {
      const delay = Date.now() - created
      skew = Math.min(delay, (skew ?? delay) + 1)
    }
    const now = () => Date.now() - (skew ?? 0)

    const refresh = () => setVersion((value) => value + 1)

    const entryFor = (sessionID: string): Entry => {
      let entry = entries.get(sessionID)
      if (!entry) {
        if (entries.size >= MAX_METERS) {
          let stalest: [string, Entry] | undefined
          for (const candidate of entries) {
            // Sessions that are working (subagents included) keep their meters.
            if (candidate[1].meter.active || family.isBusy(candidate[0], Date.now())) continue
            if (!stalest || candidate[1].touched < stalest[1].touched) stalest = candidate
          }
          if (stalest) entries.delete(stalest[0])
        }
        entry = { meter: new Meter(), touched: Date.now() }
        entries.set(sessionID, entry)
      }
      return entry
    }

    /** The meter for an event: records the event's clock reading and marks the session as alive. */
    const meterFor = (sessionID: string, created: number): Meter => {
      stamp(created)
      const entry = entryFor(sessionID)
      entry.touched = Date.now()
      return entry.meter
    }

    // One interval, alive only while something on screen moves: a session waiting for or producing tokens,
    // or one paused on tools while its subagents work (the spinner keeps turning).
    const stopTimer = () => {
      if (timer) clearInterval(timer)
      timer = undefined
    }
    const startTimer = () => {
      if (timer) return
      timer = setInterval(() => {
        const at = now()
        let busy = false
        for (const [sessionID, entry] of entries) {
          const meter = entry.meter
          if (!meter.active) continue
          if (Date.now() - entry.touched > STALE_MS) {
            meter.executionEnded(at)
            continue
          }
          if (meter.ticking) {
            busy = true
            meter.sample(at)
          } else if (subagentsUnder(sessionID) > 0) {
            busy = true
          }
        }
        setFrame((value) => value + 1)
        refresh()
        if (!busy) stopTimer()
      }, TICK_MS)
    }

    const finish = (sessionID: string, created: number) => {
      stamp(created)
      family.end(sessionID, Date.now())
      entries.get(sessionID)?.meter.executionEnded(created)
      refresh()
    }

    const stops = [
      // Sign of life from any session that is working: keeps its subagent status from going stale during
      // a long tool call. It never revives a session whose execution has ended.
      context.data.listen(({ details }) => {
        const sessionID = (details.data as { sessionID?: unknown } | undefined)?.sessionID
        if (typeof sessionID === "string") family.touch(sessionID, Date.now())
      }),
      context.data.on("session.created", (event) => {
        if (event.data.parentID) family.link(event.data.sessionID, event.data.parentID)
      }),
      context.data.on("session.status", (event) => {
        const { sessionID, status } = event.data
        if (status.type === "idle") family.end(sessionID, Date.now())
        else family.start(sessionID, Date.now())
        // A child going busy can start the spinner of a paused parent.
        startTimer()
        refresh()
      }),
      context.data.on("session.execution.started", (event) => {
        family.start(event.data.sessionID, Date.now())
        meterFor(event.data.sessionID, event.created).executionStarted(event.created)
        startTimer()
        refresh()
      }),
      context.data.on("session.execution.succeeded", (event) => finish(event.data.sessionID, event.created)),
      context.data.on("session.execution.failed", (event) => finish(event.data.sessionID, event.created)),
      context.data.on("session.execution.interrupted", (event) => finish(event.data.sessionID, event.created)),
      context.data.on("session.idle", (event) => finish(event.data.sessionID, event.created)),
      context.data.on("session.step.started", (event) => {
        family.start(event.data.sessionID, Date.now())
        entryFor(event.data.sessionID).agent = event.data.agent
        meterFor(event.data.sessionID, event.created).stepStarted(
          event.created,
          event.data.assistantMessageID,
          event.data.started,
        )
        startTimer()
        refresh()
      }),
      // Generated tokens are the answer and the reasoning. Tool-call arguments (`session.tool.input.delta`) are
      // not counted: they are not what the user watches stream, and `step.ended` accounts for them afterwards.
      context.data.on("session.text.delta", (event) => {
        meterFor(event.data.sessionID, event.created).delta(event.created, event.data.assistantMessageID, event.data.delta)
        startTimer()
      }),
      context.data.on("session.reasoning.delta", (event) => {
        meterFor(event.data.sessionID, event.created).delta(event.created, event.data.assistantMessageID, event.data.delta)
        startTimer()
      }),
      context.data.on("session.step.streamed", (event) => {
        meterFor(event.data.sessionID, event.created).stepStreamed(event.created, event.data.assistantMessageID)
        // The model went quiet: if subagents are working, the spinner has to keep turning.
        startTimer()
        refresh()
      }),
      context.data.on("session.step.ended", (event) => {
        meterFor(event.data.sessionID, event.created).stepEnded(
          event.created,
          event.data.assistantMessageID,
          event.data.tokens,
        )
        refresh()
      }),
      context.data.on("session.step.failed", (event) => {
        meterFor(event.data.sessionID, event.created).stepEnded(
          event.created,
          event.data.assistantMessageID,
          event.data.tokens,
        )
        refresh()
      }),
      context.data.on("session.retry.scheduled", (event) => {
        meterFor(event.data.sessionID, event.created).stepDiscarded()
        refresh()
      }),
      context.data.on("session.deleted", (event) => {
        family.forget(event.data.sessionID)
        entries.delete(event.data.sessionID)
        refresh()
      }),
    ]

    // -- subagents ----------------------------------------------------------

    /** A subagent's meter, while it has a response in progress. */
    const childSnapshot = (sessionID: string): Snapshot | undefined => {
      const snapshot = entries.get(sessionID)?.meter.snapshot(now())
      return snapshot && snapshot.phase !== "done" ? snapshot : undefined
    }

    const knownAgent = (sessionID: string): string | undefined =>
      entries.get(sessionID)?.agent ?? guard(undefined, () => context.data.session.get(sessionID)?.agent)

    const agentName = (sessionID: string): string => {
      const name = knownAgent(sessionID) || "subagent"
      return name.length > MAX_AGENT_NAME ? `${name.slice(0, MAX_AGENT_NAME - 1)}…` : name
    }

    // Other plugins (subagent-usage) read speeds from here; see README. It must never throw into them.
    const unpublish = publish({
      version: 1,
      snapshot: (sessionID) => {
        try {
          const snapshot = entries.get(sessionID)?.meter.snapshot(now())
          return snapshot ? toTpsSnapshot(snapshot, Date.now(), knownAgent(sessionID)) : undefined
        } catch {
          return undefined
        }
      },
    })

    // -- view ---------------------------------------------------------------

    const speedColor = (tps: number): RGBA => {
      const feedback = context.theme.text.feedback
      const tier: Tier = tierOf(tps)
      return (tier === "fast" ? feedback.success : tier === "normal" ? feedback.info : feedback.warning).base
    }

    const segmentsFor = ({ snapshot: main, subagents, solo }: View): Segment[] => {
      const theme = context.theme
      const muted = theme.text.muted
      const accent = theme.hue.accent[context.themeMode === "dark" ? 400 : 600]
      const compact = settings.mode === "compact"
      const spinner = SPINNER[frame() % SPINNER.length]!

      // One meter as segments. `brief` is the short paused form used for a subagent.
      const describe = (snapshot: Snapshot, subagents: number, brief: boolean): Segment[] => {
        const approx = snapshot.exact ? "" : "≈"

        // Summary of the response so far (or in total): the same text while paused and when done.
        const summary = (): Segment => {
          const parts: string[] = []
          if (snapshot.avg > 0) parts.push(`avg ${approx}${formatAverage(snapshot.avg)} tok/s`)
          if (brief) {
            if (!compact || parts.length === 0) parts.push(`${approx}${formatTokens(snapshot.tokens)} tok`)
          } else if (!compact) {
            if (snapshot.avg > 0 && snapshot.peak > 0) parts.push(`peak ${approx}${formatAverage(snapshot.peak)}`)
            parts.push(`${approx}${formatTokens(snapshot.tokens)} tok`)
            if (snapshot.ttftMs !== undefined) parts.push(`TTFT ${formatDuration(snapshot.ttftMs)}`)
            if (snapshot.genMs > 0) parts.push(formatDuration(snapshot.genMs))
          } else if (parts.length === 0) {
            parts.push(`${approx}${formatTokens(snapshot.tokens)} tok`)
          }
          return { text: parts.join(" · "), fg: muted }
        }

        // The main model is idle while several subagents work: say so, in the accent colour of the spinner.
        const marker: Segment = { text: formatSubagents(subagents, compact), fg: accent }

        switch (snapshot.phase) {
          case "waiting": {
            // A first step made only of tool calls (e.g. spawning subagents) never produces a token, so
            // "waiting for the first token" would be wrong and its timer would run on while they work.
            if (subagents > 0) return [{ text: `${spinner} `, fg: accent }, marker]
            const wait = !compact && snapshot.waitMs !== undefined ? ` ${formatDuration(snapshot.waitMs)}` : ""
            return [
              { text: spinner, fg: accent },
              { text: ` waiting${wait}`, fg: muted },
            ]
          }
          case "streaming": {
            const live: Segment[] = [
              { text: spinner, fg: accent },
              { text: ` ${formatRate(snapshot.tps)}`, fg: speedColor(snapshot.tps) },
              { text: " tok/s", fg: muted },
            ]
            if (compact) return live
            const bars = sparkline(snapshot.samples, SPARK_WIDTH)
            const extras = [`${formatTokens(snapshot.tokens)} tok`, formatDuration(snapshot.genMs)]
            if (snapshot.ttftMs !== undefined) extras.unshift(`TTFT ${formatDuration(snapshot.ttftMs)}`)
            return [
              ...live,
              { text: " ", fg: muted },
              ...bars.map((bar) => ({ text: bar.glyph, fg: speedColor(bar.value) })),
              // Hold the sparkline's width so the extras do not slide while it fills up.
              { text: " ".repeat(SPARK_WIDTH - bars.length + 2), fg: muted },
              { text: extras.join(" · "), fg: muted },
            ]
          }
          case "paused": {
            if (subagents === 0) return [{ text: `${SPINNER_IDLE} `, fg: muted }, summary()]
            // Subagents are working: keep the spinner turning so the line looks alive.
            return [
              { text: `${spinner} `, fg: accent },
              summary(),
              { text: " · ", fg: muted },
              marker,
            ]
          }
          case "done":
            return [summary()]
        }
      }

      // The only working subagent speaks for itself, under its name; otherwise the main meter, plus a count.
      if (solo) return [{ text: `${SUBAGENT_GLYPH} ${solo.name} `, fg: accent }, ...describe(solo.snapshot, 0, true)]
      return describe(main, subagents, false)
    }

    function Line(props: { sessionID?: string }) {
      const view = createMemo((): View | undefined => {
        version()
        if (!settings.visible) return undefined
        const route = context.ui.router.current()
        const sessionID = props.sessionID ?? (route.type === "session" ? route.sessionID : undefined)
        const snapshot = sessionID ? entries.get(sessionID)?.meter.snapshot(now()) : undefined
        if (!sessionID || !snapshot) return undefined
        // Only while the response is in progress and the model is not generating; the final summary stays clean.
        const idle = snapshot.phase === "paused" || snapshot.phase === "waiting"
        const busy = idle ? family.busy(sessionID, Date.now(), host) : []
        const child = busy.length === 1 ? childSnapshot(busy[0]!) : undefined
        const focus = chooseFocus(snapshot.phase, busy, () => child !== undefined)
        switch (focus.kind) {
          case "solo":
            return { snapshot, subagents: 1, solo: { name: agentName(focus.id), snapshot: child! } }
          case "marker":
            return { snapshot, subagents: focus.count }
          case "none":
            return { snapshot, subagents: 0 }
        }
      })

      return (
        <Show when={view()}>
          {(value: Accessor<View>) => {
            const segments = createMemo(() => segmentsFor(value()))
            return (
              <text>
                <Index each={segments()}>{(segment) => <span style={{ fg: segment().fg }}>{segment().text}</span>}</Index>
              </text>
            )
          }}
        </Show>
      )
    }

    const unslot = context.ui.slot({
      append: "prompt.footer.status",
      render: (props) => <Line sessionID={props.sessionID} />,
    })

    // -- commands -----------------------------------------------------------

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "tps.toggle",
          title: "TPS: Toggle",
          description: "Show or hide the tokens-per-second meter",
          group: "TPS",
          palette: true,
          slash: { name: "tps" },
          run: async () => {
            const visible = !settings.visible
            await updateSettings((draft) => {
              draft.visible = visible
            })
            context.ui.toast.show({ message: `TPS meter ${visible ? "shown" : "hidden"}`, variant: "info", duration: 1500 })
          },
        },
        {
          id: "tps.mode",
          title: "TPS: Cycle mode",
          description: "Switch the tokens-per-second meter between full and compact",
          group: "TPS",
          palette: true,
          slash: { name: "tps-mode" },
          run: async () => {
            const mode = settings.mode === "compact" ? "full" : "compact"
            await updateSettings((draft) => {
              draft.mode = mode
            })
            context.ui.toast.show({ message: `TPS meter: ${mode}`, variant: "info", duration: 1500 })
          },
        },
      ],
    }))

    return () => {
      stopTimer()
      for (const stop of stops) stop()
      unpublish()
      unslot()
      entries.clear()
    }
  },
})
