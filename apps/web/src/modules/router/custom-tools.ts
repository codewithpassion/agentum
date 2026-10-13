import type { Db } from "#/db/client";
import type { Agent } from "#/modules/agents/schema";
import { DESKTOP_SCREENSHOT_TOOL } from "#/modules/anthropic/config";
import type { CustomToolCall } from "#/modules/anthropic/events";
import type { CustomToolResult } from "#/modules/anthropic/gateway";
import { captureDesktop } from "#/modules/computer/desktop-capture";
import { CUSTOM_TOOL_KEY, type StoredCustomToolCall } from "./state";

/**
 * Answers the client-run tools a Managed Agents session calls. The session
 * goes idle with `requires_action` until every call has a
 * `user.custom_tool_result`, so the pump answers each one, exactly once.
 */

/** The slice of Durable Object storage this needs. */
export interface CustomToolStorage {
  get: <T>(key: string) => Promise<T | undefined>;
  put: (key: string, value: unknown) => Promise<void>;
}

export type CustomToolAnswer = Omit<CustomToolResult, "toolUseId">;

export interface CustomToolDeps {
  /** Runs one tool; never throws. */
  run: (name: string) => Promise<CustomToolAnswer>;
  send: (result: CustomToolResult) => Promise<void>;
  sessionId: string;
  storage: CustomToolStorage;
}

/**
 * Remembers every call the page carried, then answers those the session is
 * blocked on. Returns how many it answered.
 *
 * Exactly once: a call is marked answered before it runs, so a re-read of the
 * same events (the poll window overlaps, `session.status_idle` is re-emitted
 * with the remainder) cannot run it twice. The cost is at-most-once: if the
 * send fails the caller retires the session rather than retrying.
 */
export const answerCustomTools = async (
  deps: CustomToolDeps,
  calls: readonly CustomToolCall[],
  blockedOn: readonly string[]
): Promise<number> => {
  for (const call of calls) {
    const key = CUSTOM_TOOL_KEY(deps.sessionId, call.id);
    // biome-ignore lint/performance/noAwaitInLoops: local Durable Object storage, a handful of calls
    if (!(await deps.storage.get(key))) {
      await deps.storage.put(key, {
        answered: false,
        name: call.name,
      } satisfies StoredCustomToolCall);
    }
  }

  let answered = 0;
  for (const id of new Set(blockedOn)) {
    const key = CUSTOM_TOOL_KEY(deps.sessionId, id);
    // biome-ignore lint/performance/noAwaitInLoops: calls are answered in the order the session raised them
    const stored = await deps.storage.get<StoredCustomToolCall>(key);
    if (!stored || stored.answered) {
      continue;
    }
    await deps.storage.put(key, { ...stored, answered: true });
    const answer = await deps.run(stored.name);
    await deps.send({ ...answer, toolUseId: id });
    answered += 1;
  }
  return answered;
};

const UNKNOWN_TOOL = "unknown tool";

/** The tools this deployment runs for an agent. */
export const runCustomTool = async (
  db: Db,
  env: Env,
  agent: Agent | undefined,
  name: string
): Promise<CustomToolAnswer> => {
  if (name !== DESKTOP_SCREENSHOT_TOOL) {
    return { isError: true, text: UNKNOWN_TOOL };
  }
  if (!agent) {
    return { isError: true, text: "This agent no longer exists." };
  }
  try {
    const shot = await captureDesktop(db, env, agent);
    if (!shot.ok) {
      return { isError: true, text: shot.text };
    }
    return {
      image: { base64: shot.base64, mediaType: shot.mediaType },
      isError: false,
      text: `Screenshot of the desktop, ${String(shot.width)}x${String(shot.height)}.`,
    };
  } catch (error) {
    return {
      isError: true,
      text: `The screenshot failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};
