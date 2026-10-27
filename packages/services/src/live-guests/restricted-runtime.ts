/** Bounded model/tool loop. No shell, filesystem, network or native tool port.
 * The model transport returns DATA only; this adapter alone dispatches tools.
 * Production must supply an isolated durable transport, not ordinary PiRun. */
import { z } from "zod";
import { guestUnavailable } from "../runs/guest-scope.ts";
import type { RunRecord, RuntimeAdapter } from "../runs/types.ts";
import { SYSTEM_PRINCIPAL } from "../workspaces.ts";

const replySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("answer"), text: z.string().max(100_000) }),
  z.strictObject({
    input: z.record(z.string(), z.unknown()),
    kind: z.literal("tool"),
    name: z.string().max(100),
  }),
]);
export interface RestrictedTool {
  inputSchema: Record<string, unknown>;
  name: string;
}
export interface RestrictedTurn {
  input: unknown;
  name: string;
  output: unknown;
}
export interface RestrictedTransport {
  /** Model inference only. Never install provider native tools or follow URLs. */
  step: (input: {
    text: string;
    tools: readonly RestrictedTool[];
    turns: readonly RestrictedTurn[];
    signal: AbortSignal;
  }) => Promise<unknown>;
}
interface RestrictedRuntimeDeps {
  authorize: (run: RunRecord) => Promise<void>;
  /** Must use current run-token authentication and exact scoped MCP registration. */
  call: (
    run: RunRecord,
    name: string,
    input: Record<string, unknown>
  ) => Promise<unknown>;
  /** Dedicated local/durable queue; dispatch does not await inference in HTTP. */
  defer: (work: Promise<void>) => void;
  tools: (run: RunRecord) => Promise<readonly RestrictedTool[]>;
  transport: RestrictedTransport;
}

// Only reads are executable until durable approval/suggestion continuation is
// implemented. A caller cannot enable mutation by supplying another registry.
const EXECUTABLE_TOOLS = new Set([
  "document_read",
  "document_comments",
  "deck_read",
]);

const modelTurn = async (
  deps: RestrictedRuntimeDeps,
  run: RunRecord,
  controller: AbortController,
  turns: RestrictedTurn[]
) => {
  await deps.authorize(run);
  const tools = (await deps.tools(run)).filter((tool) =>
    EXECUTABLE_TOOLS.has(tool.name)
  );
  if (
    !tools.every((tool) => EXECUTABLE_TOOLS.has(tool.name)) ||
    controller.signal.aborted
  ) {
    throw guestUnavailable();
  }
  const reply = replySchema.parse(
    await deps.transport.step({
      signal: controller.signal,
      text: run.inputText,
      tools,
      turns,
    })
  );
  await deps.authorize(run);
  if (controller.signal.aborted) {
    throw guestUnavailable();
  }
  if (reply.kind === "answer") {
    return reply;
  }
  if (
    !tools.some((tool) => tool.name === reply.name) ||
    reply.input.artifactId !== run.scopeArtifactId
  ) {
    throw guestUnavailable();
  }
  const output = await deps.call(run, reply.name, reply.input);
  await deps.authorize(run);
  turns.push({ input: reply.input, name: reply.name, output });
  return reply;
};

export const createRestrictedGuestRuntime = (
  deps: RestrictedRuntimeDeps
): RuntimeAdapter => {
  const active = new Map<string, AbortController>();
  const execute: RuntimeAdapter["dispatch"] = async (
    _db,
    queued,
    _agent,
    ports
  ) => {
    if (
      !queued.scopeArtifactId ||
      queued.actor.kind !== "guest" ||
      queued.inputFileIds.length ||
      queued.reply.kind !== "none"
    ) {
      throw guestUnavailable();
    }
    if (active.has(queued.id)) {
      return;
    }
    await deps.authorize(queued);
    const run = await ports.claimRun(SYSTEM_PRINCIPAL, queued.id);
    const controller = new AbortController();
    active.set(run.id, controller);
    try {
      const turns: RestrictedTurn[] = [];

      for (let turn = 0; turn < 20; turn += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: each turn consumes the previous result.
        const reply = await modelTurn(deps, run, controller, turns);
        if (reply.kind === "answer") {
          await ports.ingestRunEvents(SYSTEM_PRINCIPAL, run.id, [
            {
              payload: { text: reply.text },
              seq: 1,
              type: "message.assistant",
            },
          ]);
          await ports.completeRun(SYSTEM_PRINCIPAL, run.id, {
            status: "done",
            text: reply.text,
          });
          return;
        }
      }
      throw new Error("Guest turn limit reached");
    } catch (error) {
      // Do not append a failure after authority ends. A valid run with malformed
      // model output ends failed rather than waiting for the lease reaper.
      try {
        await deps.authorize(run);
        await ports.completeRun(SYSTEM_PRINCIPAL, run.id, {
          error: "Restricted guest execution refused",
          status: "failed",
        });
      } catch {
        // Cancellation/access loss is fenced by the lifecycle service.
      }
      throw error;
    } finally {
      controller.abort();
      active.delete(run.id);
    }
  };
  return {
    abandon: (run) => {
      active.get(run.id)?.abort();
      return Promise.resolve();
    },
    cancel: (_db, run) => {
      active.get(run.id)?.abort();
      return Promise.resolve();
    },
    dispatch: (...args) => {
      // Queue observes failures; no unrestricted fallback is ever attempted.
      deps.defer(execute(...args));
      return Promise.resolve();
    },
    kind: "cloud",
    // This adapter has no persisted approval continuation yet. Refuse resume.
    resume: () => Promise.reject(guestUnavailable()),
  };
};
