import { DurableObject } from "cloudflare:workers";
import { createDb } from "#/db/client";
import { getAgentByIdUnscoped, listAgents } from "#/modules/agents/service";
import type { SessionStatus } from "#/modules/anthropic/events";
import {
  composeSystemPrompt,
  rosterFor,
} from "#/modules/anthropic/system-prompt";
import { getWorkspaceById } from "#/modules/workspaces/service";
import { createAiChatModel } from "./ai-model";
import type { ChatMessage } from "./chat";
import {
  MAX_CONSECUTIVE_FAILURES,
  MAX_MODEL_CALLS_PER_WAKE,
  MAX_OUTPUT_TOKENS,
  RETRY_DELAY_MS,
  STEPS_PER_ALARM,
} from "./config";
import { type RunStore, type StepDeps, type StepOutcome, step } from "./step";
import { connectWorkspaceTools, type ToolResult } from "./tools";

/**
 * One agent's loop on Cloudflare (`idFromName(agentId)`): the transcript of
 * its current session, and the alarm that advances it.
 *
 * It presents itself to the router as a session - started, sent into, polled
 * for events - so the router's pump, status broadcasts and death notices work
 * on it exactly as on a Managed Agents session. The events it emits are the
 * subset of Anthropic's the router reads: running, idle (with a stop reason),
 * terminated, error, and the model's text.
 *
 * The work happens in `alarm()`, never in the RPC that starts it: a Durable
 * Object alarm is retried if the host dies, and the transcript is the state
 * it resumes from (see `step.ts`). Each invocation runs a few steps and
 * re-arms, so a `send` or `stop` lands between steps rather than after the
 * whole task.
 */

export interface StartRunInput {
  agentId: string;
  model: string;
  sessionId: string;
  text: string;
}

export interface RunnerEvent {
  at: number;
  seq: number;
  stopReason?: string;
  text?: string;
  type: string;
}

interface RunMeta {
  agentId: string;
  cancelled: boolean;
  /** Consecutive model-call failures in this wake; reset by a success. */
  failures: number;
  model: string;
  /** Model calls spent in this wake, against `MAX_MODEL_CALLS_PER_WAKE`. */
  modelCalls: number;
  nextEventSeq: number;
  nextMessageSeq: number;
  sessionId: string;
  status: SessionStatus;
}

const RUN_KEY = "run";
const PENDING_KEY = "pending";
const PARTIAL_KEY = "partial";
const MESSAGE_PREFIX = "m:";
const EVENT_PREFIX = "e:";
const SEQ_WIDTH = 8;

const key = (prefix: string, seq: number): string =>
  `${prefix}${String(seq).padStart(SEQ_WIDTH, "0")}`;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class AgentRunner extends DurableObject<Env> {
  // --- RPC -------------------------------------------------------------------

  /** A fresh session. Whatever ran before is gone; the router never reuses it. */
  async start(input: StartRunInput): Promise<void> {
    await this.ctx.storage.deleteAll();
    const run: RunMeta = {
      agentId: input.agentId,
      cancelled: false,
      failures: 0,
      model: input.model,
      modelCalls: 0,
      nextEventSeq: 1,
      nextMessageSeq: 1,
      sessionId: input.sessionId,
      status: "running",
    };
    await this.ctx.storage.put(RUN_KEY, run);
    await this.appendMessage({ content: input.text, role: "user" });
    await this.emit({ type: "session.status_running" });
    await this.ctx.storage.setAlarm(Date.now());
  }

  /**
   * Text for the agent. Into an idle run it starts the next turn; into a busy
   * one it waits for the next step. Anything else is refused, and the router
   * answers a refusal by starting a fresh session.
   */
  async send(sessionId: string, text: string): Promise<void> {
    const run = await this.run(sessionId);
    if (!run || run.status === "terminated" || run.cancelled) {
      throw new Error("The session is no longer running.");
    }
    if (run.status === "running") {
      const pending = (await this.ctx.storage.get<string[]>(PENDING_KEY)) ?? [];
      pending.push(text);
      await this.ctx.storage.put(PENDING_KEY, pending);
      return;
    }
    await this.appendMessage({ content: text, role: "user" });
    await this.patchRun({ failures: 0, modelCalls: 0, status: "running" });
    await this.emit({ type: "session.status_running" });
    await this.ctx.storage.setAlarm(Date.now());
  }

  /** Events after `afterSeq`. An unknown session reads as terminated. */
  async events(sessionId: string, afterSeq: number): Promise<RunnerEvent[]> {
    const run = await this.run(sessionId);
    if (!run) {
      return [
        {
          at: Date.now(),
          seq: afterSeq + 1,
          type: "session.status_terminated",
        },
      ];
    }
    const stored = await this.ctx.storage.list<RunnerEvent>({
      prefix: EVENT_PREFIX,
      startAfter: key(EVENT_PREFIX, afterSeq),
    });
    return [...stored.values()];
  }

  async status(sessionId: string): Promise<SessionStatus> {
    const run = await this.run(sessionId);
    return run ? run.status : "terminated";
  }

  async stop(sessionId: string): Promise<void> {
    const run = await this.run(sessionId);
    if (!run) {
      return;
    }
    await this.patchRun({ cancelled: true, status: "terminated" });
    await this.emit({ type: "session.status_terminated" });
  }

  // --- alarm -----------------------------------------------------------------

  override async alarm(): Promise<void> {
    const run = await this.ctx.storage.get<RunMeta>(RUN_KEY);
    if (run?.status !== "running") {
      return;
    }
    try {
      await this.advance(run);
    } catch (error) {
      // Never rethrown: a throwing alarm is retried by the platform, and a
      // failure the loop could not absorb is a failure the session reports.
      await this.fail(messageOf(error));
    }
  }

  private async advance(initial: RunMeta): Promise<void> {
    const db = createDb(this.env.DB);
    const agent = await getAgentByIdUnscoped(db, initial.agentId);
    const workspace = agent
      ? await getWorkspaceById(db, agent.workspaceId)
      : undefined;
    if (!(agent && workspace)) {
      await this.finish("terminated");
      return;
    }
    if (!this.env.AI) {
      await this.fail(
        "The Workers AI binding (AI) is not configured for this deployment."
      );
      return;
    }

    const roster = rosterFor(agent.id, await listAgents(db, workspace.id));
    const tools = await connectWorkspaceTools({
      agent,
      db,
      env: this.env,
      requestUrl: this.env.PUBLIC_APP_URL || "http://localhost/",
      workspace: { id: workspace.id, slug: workspace.slug },
    });
    const deps: StepDeps = {
      emitText: (text: string) => this.emit({ text, type: "agent.message" }),
      maxTokens: MAX_OUTPUT_TOKENS,
      model: createAiChatModel(this.env.AI, {
        gatewayId: this.env.AI_GATEWAY_ID || undefined,
      }),
      modelId: initial.model,
      system: composeSystemPrompt({
        instructions: agent.instructions,
        name: agent.name,
        roster,
        runtime: "cloudflare",
        soul: agent.soul,
      }),
      tools,
    };

    try {
      await this.runSteps(deps);
    } finally {
      await tools.close().catch(() => {
        // The pipe is in-memory; there is nothing a failed close can leak.
      });
    }
  }

  /** A bounded burst of steps, then the alarm is re-armed for the next one. */
  private async runSteps(deps: StepDeps): Promise<void> {
    for (let i = 0; i < STEPS_PER_ALARM; i += 1) {
      // Re-read each step: a `send` or `stop` may have landed meanwhile.
      // biome-ignore lint/performance/noAwaitInLoops: steps are sequential by nature
      const run = await this.ctx.storage.get<RunMeta>(RUN_KEY);
      if (run?.status !== "running") {
        return;
      }
      if (run.modelCalls >= MAX_MODEL_CALLS_PER_WAKE) {
        await this.finish("idle", "max_model_calls");
        return;
      }
      const outcome = await this.stepOnce(run, deps);
      if (outcome === "retry" || !(await this.settle(run, outcome))) {
        return;
      }
    }
    await this.ctx.storage.setAlarm(Date.now());
  }

  /**
   * One step, with a failed model call absorbed into a delayed retry until
   * the failures run out - then it propagates, and the alarm fails the run.
   */
  private async stepOnce(
    run: RunMeta,
    deps: StepDeps
  ): Promise<StepOutcome | "retry"> {
    try {
      return await step(this.store(), deps);
    } catch (error) {
      if (run.failures + 1 >= MAX_CONSECUTIVE_FAILURES) {
        throw error;
      }
      await this.patchRun({ failures: run.failures + 1 });
      await this.ctx.storage.setAlarm(Date.now() + RETRY_DELAY_MS);
      return "retry";
    }
  }

  /** Records a step's outcome; false when the run is over. */
  private async settle(run: RunMeta, outcome: StepOutcome): Promise<boolean> {
    if (outcome.kind === "cancelled") {
      await this.finish("terminated");
      return false;
    }
    if (outcome.kind === "idle") {
      await this.finish("idle", "end_turn");
      return false;
    }
    if (outcome.calledModel) {
      await this.patchRun({ failures: 0, modelCalls: run.modelCalls + 1 });
    }
    return true;
  }

  // --- state -----------------------------------------------------------------

  private async run(sessionId: string): Promise<RunMeta | undefined> {
    const run = await this.ctx.storage.get<RunMeta>(RUN_KEY);
    return run?.sessionId === sessionId ? run : undefined;
  }

  /**
   * Every write to the run meta goes through here, merged onto what is stored
   * at that moment. The counters move while a step runs (each appended message and
   * event advances one), so writing back a copy read before the step would
   * roll them back and overwrite what the step just stored.
   */
  private async patchRun(patch: Partial<RunMeta>): Promise<void> {
    const run = await this.ctx.storage.get<RunMeta>(RUN_KEY);
    if (!run) {
      return;
    }
    await this.ctx.storage.put(RUN_KEY, { ...run, ...patch } satisfies RunMeta);
  }

  private async finish(
    status: "idle" | "terminated",
    stopReason?: string
  ): Promise<void> {
    await this.patchRun({ status });
    await this.emit({
      ...(stopReason ? { stopReason } : {}),
      type:
        status === "idle" ? "session.status_idle" : "session.status_terminated",
    });
  }

  private async fail(message: string): Promise<void> {
    await this.emit({ text: message, type: "session.error" });
    await this.finish("idle", "error");
  }

  private async emit(event: Omit<RunnerEvent, "at" | "seq">): Promise<void> {
    const run = await this.ctx.storage.get<RunMeta>(RUN_KEY);
    if (!run) {
      return;
    }
    const seq = run.nextEventSeq;
    await this.ctx.storage.put(key(EVENT_PREFIX, seq), {
      ...event,
      at: Date.now(),
      seq,
    } satisfies RunnerEvent);
    await this.patchRun({ nextEventSeq: seq + 1 });
  }

  private async appendMessage(message: ChatMessage): Promise<void> {
    const run = await this.ctx.storage.get<RunMeta>(RUN_KEY);
    if (!run) {
      return;
    }
    await this.ctx.storage.put(
      key(MESSAGE_PREFIX, run.nextMessageSeq),
      message
    );
    await this.patchRun({ nextMessageSeq: run.nextMessageSeq + 1 });
  }

  private store(): RunStore {
    return {
      appendMessage: (message) => this.appendMessage(message),
      clearPartialResults: async () => {
        await this.ctx.storage.delete(PARTIAL_KEY);
      },
      isCancelled: async () =>
        (await this.ctx.storage.get<RunMeta>(RUN_KEY))?.cancelled ?? true,
      messages: async () => {
        const stored = await this.ctx.storage.list<ChatMessage>({
          prefix: MESSAGE_PREFIX,
        });
        return [...stored.values()];
      },
      partialResults: async () =>
        (await this.ctx.storage.get<Record<string, ToolResult>>(PARTIAL_KEY)) ??
        {},
      savePartialResult: async (callId, result) => {
        const partial =
          (await this.ctx.storage.get<Record<string, ToolResult>>(
            PARTIAL_KEY
          )) ?? {};
        partial[callId] = result;
        await this.ctx.storage.put(PARTIAL_KEY, partial);
      },
      takePending: async () => {
        const pending =
          (await this.ctx.storage.get<string[]>(PENDING_KEY)) ?? [];
        if (pending.length > 0) {
          await this.ctx.storage.delete(PENDING_KEY);
        }
        return pending;
      },
    };
  }
}
