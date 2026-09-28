/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { createSignal, Show } from "solid-js"

function formatTokens(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value)
}

function formatCost(value: number): string {
  return `$${value.toFixed(value < 0.01 ? 4 : 2)}`
}

function tokenTotal(tokens: { input: number; output: number; cache: { read: number; write: number } }): number {
  // Reasoning is a breakdown of output for some providers, not an extra charge.
  return tokens.input + tokens.output + tokens.cache.read + tokens.cache.write
}

export default Plugin.define({
  id: "subagent-usage",
  setup(context) {
    const [starts, setStarts] = createSignal<Record<string, { tokens: number; cost: number }>>({})
    const stopStart = context.data.on("session.execution.started", (event) => {
      const id = event.data.sessionID
      const session = context.data.session.get(id)
      if (!session) return
      // Snapshot at the start, since SessionInfo.tokens/cost cover *all* runs.
      setStarts((previous) => ({
        ...previous,
        [id]: { tokens: tokenTotal(session.tokens), cost: session.cost },
      }))
    })

    const usage = (id: string) => {
      const session = context.data.session.get(id)
      if (!session) return { tokens: 0, cost: 0 }
      const start = starts()[id]
      if (start) {
        return {
          tokens: Math.max(0, tokenTotal(session.tokens) - start.tokens),
          cost: Math.max(0, session.cost - start.cost),
        }
      }

      // After a TUI reload an execution may already be underway. The last
      // idle marker separates this run from previous ones in the transcript.
      const messages = context.data.session.message.list(id)
      const boundary = messages.findLastIndex((message) => message.type === "idle")
      return messages.slice(boundary + 1).reduce((sum, message) => {
        if (message.type !== "assistant" || !message.tokens) return sum
        return {
          tokens: sum.tokens + tokenTotal(message.tokens),
          cost: sum.cost + (message.cost ?? 0),
        }
      }, { tokens: 0, cost: 0 })
    }

    const footerCleanup = context.ui.slot({
      append: "prompt.footer.status",
      render: ({ sessionID }) => {
        const family = () => {
          if (!sessionID) return []
          const sessions = new Map(
            [...new Set(context.data.session.family(sessionID))]
              .map((id) => context.data.session.get(id))
              .filter((session) => session !== undefined)
              .map((session) => [session.id, session]),
          )

          return [...sessions.values()].filter((session) => {
            let current = session
            const visited = new Set<string>()
            while (current.parentID) {
              if (current.parentID === sessionID) return true
              if (visited.has(current.id)) return false
              visited.add(current.id)
              const parent = sessions.get(current.parentID)
              if (!parent) return false
              current = parent
            }
            return session.id === sessionID
          })
        }

        const modelName = (id: string) => {
          const session = context.data.session.get(id)
          if (!session) return "model pending"
          const messages = context.data.session.message.list(id)
          const latest = [...messages].reverse().find((message) => message.type === "assistant")
          return (latest?.model ?? session.model)?.id ?? "model pending"
        }

        const label = () => {
          if (!sessionID) return undefined
          const current = context.data.session.get(sessionID)
          if (current?.parentID) {
            const spent = usage(sessionID)
            return `${modelName(sessionID)} · ${formatTokens(spent.tokens)} tokens · ${formatCost(spent.cost)}`
          }
          const descendants = family().filter((session) => session.id !== sessionID)
          const running = descendants.filter((session) => context.data.session.status(session.id) === "running")
          if (!running.length) return undefined
          const models = [...new Set(running.map((session) => modelName(session.id)))].join(", ")
          const tokens = running.reduce((sum, session) => sum + usage(session.id).tokens, 0)
          return `${models} · ${formatTokens(tokens)} tokens`
        }

        return (
          <Show when={label()}>
            {(value) => <text>{value()}</text>}
          </Show>
        )
      },
    })

    const sidebarCleanup = context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => {
        const running = () => {
          const sessions = new Map(
            [...new Set(context.data.session.family(sessionID))]
              .map((id) => context.data.session.get(id))
              .filter((session) => session !== undefined)
              .map((session) => [session.id, session]),
          )
          const descendants = [...sessions.values()].filter((session) => {
            let current = session
            const visited = new Set<string>()
            while (current.parentID) {
              if (current.parentID === sessionID) return true
              if (visited.has(current.id)) return false
              visited.add(current.id)
              const parent = sessions.get(current.parentID)
              if (!parent) return false
              current = parent
            }
            return false
          })

          return descendants
            .filter((session) => context.data.session.status(session.id) === "running")
            .map((session) => {
              const messages = context.data.session.message.list(session.id)
              const latest = [...messages].reverse().find((message) => message.type === "assistant")
              const model = (latest?.model ?? session.model)?.id ?? "unknown model"
              return {
                id: session.id,
                name: session.agent ?? session.title ?? "subagent",
                model,
                ...usage(session.id),
              }
            })
        }

        return (
          <Show when={running().length > 0}>
            <box flexDirection="column">
              <text>Subagents</text>
              {running().map((child) => (
                <box flexDirection="column">
                  <text>{child.name} · {child.model}</text>
                  <text>{formatTokens(child.tokens)} tokens · {formatCost(child.cost)}</text>
                </box>
              ))}
            </box>
          </Show>
        )
      },
    })

    return () => {
      stopStart()
      footerCleanup()
      sidebarCleanup()
    }
  },
})
