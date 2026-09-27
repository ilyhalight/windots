import { Plugin } from "@opencode/plugin";

type ModelRef = `${string}/${string}`;

const CHAINS: Record<string, readonly ModelRef[]> = {
  orchestrator: [
    "openai/gpt-6-sol",
    "google-agy/gemini-3.8-flash",
    "openrouter/deepseek/deepseek-v4.1-flash",
    "opencode/muse-spark-1.3-contributor-free",
  ],

  quick: [
    "inception/mercury-2.5",
    "opencode/muse-spark-1.3-contributor-free",
    "google-agy/gemini-3.8-flash",
    "openrouter/deepseek/deepseek-v4.1-flash",
  ],

  explore: [
    "google-agy/gemini-3.8-flash",
    "openrouter/z-ai/glm-5.3-flash",
    "openrouter/deepseek/deepseek-v4.1-flash",
  ],

  implement: [
    "openai/gpt-6-luna",
    // big TTFT but free
    "xkiro/qwen/qwen3.8-omni-flash:free",
    "openrouter/deepseek/deepseek-v4.1-flash",
    "opencode/muse-spark-1.3-contributor-free",
    "google-agy/gemini-3.8-flash",
  ],

  "implement-hard": [
    "opencode/muse-spark-1.3-contributor-free",
    "openrouter/deepseek/deepseek-v4.1-flash",
    "google-agy/gemini-3.8-flash",
  ],

  review: [
    "google-agy/gemini-3.8-flash",
    "openrouter/z-ai/glm-5.3-flash",
    "openrouter/deepseek/deepseek-v4.1-flash",
  ],
};

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

const RETRYABLE_TEXT =
  /rate.?limit|usage.?limit|usage.?exceeded|quota|too many requests|high concurrency|overload|service unavailable|temporarily unavailable|capacity|timeout|timed out|try again later/i;

interface SessionState {
  agent?: string;
  model?: ModelRef;
}

function modelRef(providerID: string, modelID: string): ModelRef {
  return `${providerID}/${modelID}`;
}

function parseModel(model: ModelRef) {
  const slash = model.indexOf("/");

  return {
    providerID: model.slice(0, slash),
    modelID: model.slice(slash + 1),
  };
}

function stringifyError(error: unknown): string {
  if (typeof error === "string") return error;

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function findStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return;

  const value = error as Record<string, any>;

  const status =
    value.status ??
    value.statusCode ??
    value.data?.status ??
    value.data?.statusCode;

  if (typeof status === "number") return status;

  if (value.cause) {
    return findStatus(value.cause);
  }
}

function isRetryable(error: unknown): boolean {
  const status = findStatus(error);

  if (status !== undefined && RETRYABLE_STATUS.has(status)) {
    return true;
  }

  return RETRYABLE_TEXT.test(stringifyError(error));
}

function getCooldown(error: unknown): number {
  const text = stringifyError(error);

  // Usage/quota limits usually take much longer to recover.
  if (/usage.?limit|usage.?exceeded|quota/i.test(text)) {
    return 30 * 60_000;
  }

  if (findStatus(error) === 429 || /rate.?limit/i.test(text)) {
    return 5 * 60_000;
  }

  // timeout / 5xx
  return 30_000;
}

function prepareParts(parts: any[]) {
  return parts
    .filter((part) =>
      ["text", "file", "agent", "subtask"].includes(part.type),
    )
    .map((part) => {
      const copy = structuredClone(part);

      delete copy.id;
      delete copy.sessionID;
      delete copy.messageID;

      return copy;
    });
}

export default Plugin.define({
  id: "agent-fallback",
  async setup(ctx) {
    const directory = ctx.location.directory;

    const sessions = new Map<string, SessionState>();

    // model -> timestamp when it can be tried again.
    const cooldown = new Map<ModelRef, number>();

    // Prevents two error events from triggering a fallback for the same session.
    const handling = new Set<string>();

    // OpenCode may emit session.status + message.updated + session.error for the same failure.
    const recentlyHandled = new Map<string, number>();

    const log = async (
      level: "debug" | "info" | "warn" | "error",
      message: string,
      extra?: Record<string, unknown>,
    ) => {
      console[level === "debug" ? "log" : level](
        `[agent-fallback] ${message}`,
        extra ?? "",
      );
    };

    const available = (model: ModelRef) => {
      const until = cooldown.get(model);

      if (!until) return true;

      if (Date.now() >= until) {
        cooldown.delete(model);
        return true;
      }

      return false;
    };

    const findNextModel = (
      agent: string,
      current: ModelRef,
    ): ModelRef | undefined => {
      const chain = CHAINS[agent];

      if (!chain) return;

      const currentIndex = chain.indexOf(current);

      // If the current model is not in the chain, start from the beginning.
      const start = currentIndex === -1 ? 0 : currentIndex + 1;

      for (let i = start; i < chain.length; i++) {
        const candidate = chain[i];

        if (available(candidate)) {
          return candidate;
        }
      }
    };

    const resolveSession = async (sessionID: string) => {
      const existing = sessions.get(sessionID) ?? {};

      const messages = await ctx.session.context({ sessionID });

      const lastUser = [...messages]
        .reverse()
        .find((message: any) => message.type === "user");

      const lastAssistant = [...messages]
        .reverse()
        .find((message: any) => message.type === "assistant");

      // The assistant message carries the agent and model actually used.
      if (lastAssistant) {
        existing.agent ??= (lastAssistant as any).agent;
        const model = (lastAssistant as any).model;
        if (model) {
          existing.model = modelRef(model.providerID, model.id);
        }
      }

      sessions.set(sessionID, existing);

      return {
        state: existing,
        messages,
        lastUser,
      };
    };

    const fallback = async (sessionID: string, error: unknown) => {
      if (handling.has(sessionID)) return;
      if (!isRetryable(error)) return;

      handling.add(sessionID);

      try {
        const { state, lastUser } = await resolveSession(sessionID);

        if (!state.agent || !state.model || !lastUser) {
          await log("warn", "Cannot resolve session fallback state", {
            sessionID,
          });

          return;
        }

        const dedupeKey = `${sessionID}:${state.model}`;

        const previous = recentlyHandled.get(dedupeKey);

        if (previous && Date.now() - previous < 5000) {
          return;
        }

        recentlyHandled.set(dedupeKey, Date.now());

        const chain = CHAINS[state.agent];

        if (!chain) {
          return;
        }

        const failedModel = state.model;

        cooldown.set(failedModel, Date.now() + getCooldown(error));

        const next = findNextModel(state.agent, failedModel);

        if (!next) {
          await log("error", "Fallback chain exhausted", {
            sessionID,
            agent: state.agent,
            model: failedModel,
          });

          console.error(
            `[agent-fallback] ${state.agent}: no available fallback models`,
          );

          return;
        }

        await log("warn", "Switching fallback model", {
          sessionID,
          agent: state.agent,
          from: failedModel,
          to: next,
        });

        /*
         * Stop OpenCode's built-in retry first, otherwise the original
         * model and the fallback could start simultaneously.
         */
        await ctx.session
          .interrupt({ sessionID, continue: false })
          .catch(() => {});

        // Give the session time to transition from busy/retry to idle.
        await new Promise((resolve) => setTimeout(resolve, 150));

        /*
         * Note: the V2 plugin context does not expose the revert API,
         * so the failed assistant turn stays in history. The fallback
         * prompt below continues the session from the next model,
         * which preserves behavior closely enough: the retryable error
         * turn is still visible, but the user request is re-executed.
         */

        const userText = (lastUser as any).text as string;

        if (!userText) {
          throw new Error(
            "Cannot replay fallback: user message has no text",
          );
        }

        state.model = next;

        console.warn(
          `[agent-fallback] ${state.agent}: ${failedModel} → ${next}`,
        );

        // Replay the original user turn on the next model.
        await ctx.session.switchModel({
          sessionID,
          model: {
            providerID: parseModel(next).providerID,
            id: parseModel(next).modelID,
          },
        });

        await ctx.session.prompt({
          sessionID,
          text: userText,
        });
      } catch (error) {
        await log("error", "Fallback failed", {
          sessionID,
          error: stringifyError(error),
        });

        console.error(`[agent-fallback] Fallback failed: ${stringifyError(error)}`);
      } finally {
        handling.delete(sessionID);
      }
    };

    const controller = new AbortController();

    void (async () => {
      for await (const event of ctx.event.subscribe({
        signal: controller.signal,
      })) {
        if (event.type === "message.updated") {
          const info = (event as any).properties?.info;
          if (!info) continue;

          const sessionID = info.sessionID;
          const state = sessions.get(sessionID) ?? {};

          if (info.role === "user") {
            // User messages don't carry agent/model in V2; track via assistant.
            sessions.set(sessionID, state);
            continue;
          }

          if (info.role === "assistant") {
            state.agent = info.agent ?? state.agent;
            state.model = modelRef(
              info.providerID,
              info.modelID ?? info.model?.id,
            );
            sessions.set(sessionID, state);

            if (info.error && isRetryable(info.error)) {
              await fallback(sessionID, info.error);
            }
          }

          continue;
        }

        if (event.type === "session.status") {
          const { sessionID, status } = (event as any).properties ?? {};

          if (status?.type === "retry" && isRetryable(status.message)) {
            await fallback(sessionID, status.message);
          }

          continue;
        }

        if (event.type === "session.error") {
          const { sessionID, error } = (event as any).properties ?? {};

          if (sessionID && isRetryable(error)) {
            await fallback(sessionID, error);
          }

          continue;
        }

        if (event.type === "session.deleted") {
          const id = (event as any).properties?.info?.id;
          if (id) sessions.delete(id);
        }
      }
    })();

    return () => controller.abort();
  },
});
