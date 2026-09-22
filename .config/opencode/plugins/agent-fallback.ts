import type { Plugin } from "@opencode-ai/plugin";

type ModelRef = `${string}/${string}`;

const CHAINS: Record<string, readonly ModelRef[]> = {
  orchestrator: [
    "openai/gpt-5.6-sol",
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

  const status = value.status ?? value.statusCode ?? value.data?.status ?? value.data?.statusCode;

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

  // Usage/quota обычно восстанавливаются намного дольше.
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
    .filter((part) => ["text", "file", "agent", "subtask"].includes(part.type))
    .map((part) => {
      const copy = structuredClone(part);

      delete copy.id;
      delete copy.sessionID;
      delete copy.messageID;

      return copy;
    });
}

export const AgentFallback: Plugin = async ({ client, directory }) => {
  const sessions = new Map<string, SessionState>();

  // model -> timestamp, когда снова можно пробовать.
  const cooldown = new Map<ModelRef, number>();

  // Не даём двум error events одновременно делать fallback
  // одной session.
  const handling = new Set<string>();

  // OpenCode может прислать session.status + message.updated +
  // session.error для одного и того же failure.
  const recentlyHandled = new Map<string, number>();

  const log = async (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    extra?: Record<string, unknown>,
  ) => {
    await client.app
      .log({
        body: {
          service: "agent-fallback",
          level,
          message,
          extra,
        },
      })
      .catch(() => {});
  };

  const toast = async (
    title: string,
    message: string,
    variant: "info" | "success" | "warning" | "error",
  ) => {
    await client.tui
      .showToast({
        body: {
          title,
          message,
          variant,
          duration: 5000,
        },
      })
      .catch(() => {});
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

  const findNextModel = (agent: string, current: ModelRef): ModelRef | undefined => {
    const chain = CHAINS[agent];

    if (!chain) return;

    const currentIndex = chain.indexOf(current);

    // Если текущая модель почему-то не входит в chain,
    // начинаем с начала.
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

    const response = await client.session.messages({
      path: { id: sessionID },
      query: { directory },
    });

    const messages = response.data ?? [];

    const lastUser = [...messages].reverse().find((message) => message.info.role === "user");

    const lastAssistant = [...messages]
      .reverse()
      .find((message) => message.info.role === "assistant");

    if (lastUser?.info.role === "user") {
      existing.agent ??= lastUser.info.agent;

      if (lastUser.info.model) {
        existing.model ??= modelRef(lastUser.info.model.providerID, lastUser.info.model.modelID);
      }
    }

    if (lastAssistant?.info.role === "assistant") {
      existing.model = modelRef(lastAssistant.info.providerID, lastAssistant.info.modelID);
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

        await toast(
          "Model fallback exhausted",
          `${state.agent}: no available fallback models`,
          "error",
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
       * Важно остановить встроенный retry OpenCode,
       * иначе original model и fallback могут стартовать
       * одновременно.
       */
      await client.session
        .abort({
          path: { id: sessionID },
          query: { directory },
        })
        .catch(() => {});

      // Даём session перейти из busy/retry в idle.
      await Bun.sleep(150);

      /*
       * Удаляем failed turn вместе с частичными tool effects.
       *
       * Это полезно, если модель успела вызвать несколько tools,
       * а потом provider упал посреди turn.
       */
      await client.session.revert({
        path: { id: sessionID },
        body: {
          messageID: lastUser.info.id,
        },
        query: { directory },
      });

      const parts = prepareParts(lastUser.parts);

      if (!parts.length) {
        throw new Error("Cannot replay fallback: user message has no replayable parts");
      }

      state.model = next;

      await toast("Model fallback", `${state.agent}: ${failedModel} → ${next}`, "warning");

      /*
       * Повторяем исходный user turn,
       * но уже на следующей модели.
       */
      await client.session.promptAsync({
        path: { id: sessionID },
        query: { directory },
        body: {
          agent: state.agent,
          model: parseModel(next),
          parts,
        },
      });
    } catch (error) {
      await log("error", "Fallback failed", {
        sessionID,
        error: stringifyError(error),
      });

      await toast("Fallback failed", stringifyError(error), "error");
    } finally {
      handling.delete(sessionID);
    }
  };

  return {
    event: async ({ event }) => {
      if (event.type === "message.updated") {
        const info = event.properties.info;
        const sessionID = info.sessionID;

        const state = sessions.get(sessionID) ?? {};

        if (info.role === "user") {
          state.agent = info.agent;

          state.model = modelRef(info.model.providerID, info.model.modelID);

          sessions.set(sessionID, state);

          return;
        }

        if (info.role === "assistant") {
          state.model = modelRef(info.providerID, info.modelID);

          sessions.set(sessionID, state);

          if (info.error && isRetryable(info.error)) {
            await fallback(sessionID, info.error);
          }
        }

        return;
      }

      if (event.type === "session.status") {
        const { sessionID, status } = event.properties;

        if (status.type === "retry" && isRetryable(status.message)) {
          await fallback(sessionID, status.message);
        }

        return;
      }

      if (event.type === "session.error") {
        const { sessionID, error } = event.properties;

        if (sessionID && isRetryable(error)) {
          await fallback(sessionID, error);
        }

        return;
      }

      if (event.type === "session.deleted") {
        sessions.delete(event.properties.info.id);
      }
    },
  };
};
