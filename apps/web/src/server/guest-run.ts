import { DurableObject } from "cloudflare:workers";
import { isForbiddenError } from "@repo/services/authz";
import { isServiceError } from "@repo/services/errors";
import { createScopedGuestComments } from "@repo/services/live-guests/scoped-comments";
import { SYSTEM_PRINCIPAL } from "@repo/services/workspaces";
import { ZodError } from "zod";
import { type Composed, compose } from "./compose";
import {
  createGuestRunCore,
  GuestContractError,
  type GuestExecutionState,
  type GuestRunCoreDeps,
} from "./guest-run-core";
import { guestInference } from "./guest-run-inference";
import { guestRunRpc } from "./guest-run-rpc";

/** A separate SQL-backed object per guest run. Never opens PiRun or a VM. */
export class GuestRun extends DurableObject<Env> {
  #composed?: Composed;
  #working?: Promise<void>;
  protected composed() {
    this.#composed ??= compose(
      this.env,
      false,
      (work) => this.ctx.waitUntil(work),
      this.ctx.exports
    );
    return this.#composed;
  }
  /** Fixture subclasses override inference explicitly; production has no faux/env switch. */
  protected async inference(input: Parameters<GuestRunCoreDeps["infer"]>[0]) {
    const stored = await this.ctx.storage.get<GuestExecutionState>("execution");
    if (!stored) {
      throw new Error("Missing guest execution");
    }
    const composed = this.composed();
    const { run } = await composed.services.runs.guestExecution(
      SYSTEM_PRINCIPAL,
      stored.runId
    );
    return guestInference(async (provider) => {
      const key =
        provider === "anthropic"
          ? await composed.services.managedKeys.resolve(run.workspaceId)
          : await composed.services.modelKeys.resolve(
              run.workspaceId,
              provider
            );
      return key?.apiKey ?? null;
    })({
      ...input,
      context: await composed.services.runs.guestContext(
        SYSTEM_PRINCIPAL,
        stored.runId
      ),
    });
  }
  #core() {
    const composed = this.composed();
    const { runs, requests } = composed.services;
    const rpc = guestRunRpc(this.env, composed);
    const comments = createScopedGuestComments({
      ...composed,
      events: composed.services.events,
      guestsOff: () =>
        Boolean(
          (this.env as Env & { LIVE_GUESTS_OFF?: string }).LIVE_GUESTS_OFF
        ),
      runs,
    });
    return createGuestRunCore({
      claim: async (id) => {
        try {
          await runs.claimRun(SYSTEM_PRINCIPAL, id, { leaseMs: 120_000 });
          return true;
        } catch (error) {
          if (isServiceError(error) && error.code === "conflict") {
            return false;
          }
          throw error;
        }
      },
      complete: async (id, text) => {
        await comments.answer(SYSTEM_PRINCIPAL, id, text);
        await runs.completeRun(SYSTEM_PRINCIPAL, id, { status: "done", text });
      },
      execution: (id) => runs.guestExecution(SYSTEM_PRINCIPAL, id),
      heartbeat: async (id) => {
        await runs.heartbeatRun(SYSTEM_PRINCIPAL, id, { leaseMs: 120_000 });
      },
      infer: (input) => this.inference(input),
      ingest: async (id, events) => {
        await runs.ingestRunEvents(SYSTEM_PRINCIPAL, id, events);
      },
      invoke: (run, name, input, callId) =>
        rpc(run, "tools/call", { arguments: input, name }, callId),
      now: () => composed.clock.now().getTime(),
      open: (run, reply, callId) => {
        if (reply.kind === "question") {
          return requests.open(SYSTEM_PRINCIPAL, {
            kind: "question",
            questions: reply.questions,
            runId: run.id,
            toolName: "guest_question",
            toolUseId: callId,
          });
        }
        if (reply.kind !== "tool") {
          throw new Error("Unsupported guest request");
        }
        return requests.open(SYSTEM_PRINCIPAL, {
          input: reply.input,
          kind: "approval",
          runId: run.id,
          toolKey: `harbourmaster/${reply.name}`,
          toolName: reply.name,
          toolUseId: callId,
        });
      },
      outcome: (id) => requests.outcome(SYSTEM_PRINCIPAL, id),
      store: {
        alarm: (at) => this.ctx.storage.setAlarm(at),
        get: () => this.ctx.storage.get<GuestExecutionState>("execution"),
        put: (state) => this.ctx.storage.put("execution", state),
      },
      tools: async (run) =>
        (await rpc(run, "tools/list", {}, `list:${run.id}`))?.tools ?? [],
    });
  }
  async start(runId: string) {
    if (
      this.ctx.id.toString() !== this.env.GUEST_RUN.idFromName(runId).toString()
    ) {
      throw new Error("Wrong guest executor scope");
    }
    await this.composed().services.runs.guestExecution(SYSTEM_PRINCIPAL, runId);
    await this.#core().start(runId);
  }
  async cancel(runId: string) {
    const state = await this.ctx.storage.get<GuestExecutionState>("execution");
    if (state?.runId === runId) {
      await this.ctx.storage.put("execution", { ...state, phase: "done" });
    }
  }
  override async alarm() {
    if (this.#working) {
      return this.#working;
    }
    this.#working = this.#step().finally(() => {
      this.#working = undefined;
    });
    await this.#working;
  }
  async #step() {
    try {
      await this.#core().step();
    } catch (error) {
      const state =
        await this.ctx.storage.get<GuestExecutionState>("execution");
      if (isForbiddenError(error) && state) {
        await this.composed().services.runs.cancelRun(
          SYSTEM_PRINCIPAL,
          state.runId
        );
        await this.ctx.storage.put("execution", { ...state, phase: "done" });
        return;
      }
      if (state) {
        const failures = (state.failures ?? 0) + 1;
        if (
          error instanceof GuestContractError ||
          error instanceof ZodError ||
          failures >= 5
        ) {
          await this.composed().services.runs.completeRun(
            SYSTEM_PRINCIPAL,
            state.runId,
            { error: "Restricted guest execution refused", status: "failed" }
          );
          await this.ctx.storage.put("execution", {
            ...state,
            failures,
            phase: "done",
          });
          return;
        }
        await this.ctx.storage.put("execution", { ...state, failures });
      }
      await this.ctx.storage.setAlarm(Date.now() + 5000);
      throw error;
    }
  }
}
