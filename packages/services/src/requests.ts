import type { Database } from "@repo/db";
import type { Atomic } from "@repo/db/atomic";
import { runRequests } from "@repo/db/schema/requests";
import { sessions } from "@repo/db/schema/sessions";
import { agentToolRules } from "@repo/db/schema/tool-rules";
import {
  APPROVAL_TTL_MS,
  QUESTION_TTL_MS,
  TOOL_RULE_MODES,
} from "@repo/db/shared";
import {
  approvalAnswerSchema,
  approvalSummary,
  toolKey as canonicalToolKey,
  questionAnswerSchema,
} from "@repo/protocol/requests";
import { and, eq, inArray, lte } from "drizzle-orm";
import { ulid } from "ulidx";
import { z } from "zod";
import { findAgent } from "./agents.ts";
import { authorize, ForbiddenError } from "./authz.ts";
import { ServiceError } from "./errors.ts";
import { redactToolPayload } from "./events/scrub.ts";
import type { EventInput, EventsService } from "./events.ts";
import {
  answerInputSchema,
  capInput,
  openInputSchema,
  outcomeOf,
  type RequestRow,
  requestRecord,
  runtimeAnswers,
  scrubAnswer,
  scrubbedRecord,
  scrubText,
} from "./requests/records.ts";
import { loadRun } from "./runs/queries.ts";
import type { Clock, RunRecord } from "./runs/types.ts";
import type { RunsService } from "./runs.ts";
import type { SecretsService } from "./secrets.ts";
import { visibleSessions } from "./sessions.ts";
import { type Principal, SYSTEM_PRINCIPAL } from "./workspaces.ts";

export type { RequestRecord } from "./requests/records.ts";

const id = z.string().min(1).max(200);
export const pendingInputSchema = z.strictObject({ sessionId: id.optional() });
export const rulesListInputSchema = z.strictObject({ agentId: id });
export const ruleKeyInputSchema = rulesListInputSchema.extend({ toolKey: id });
export const ruleSetInputSchema = ruleKeyInputSchema.extend({
  mode: z.enum(TOOL_RULE_MODES),
});
export const webAnswerInputSchema = z.union([
  approvalAnswerSchema.extend({ requestId: id }),
  questionAnswerSchema.extend({ requestId: id }),
]);

const WAIT_POLL_MS = 500;
const ended = [
  "run.finished",
  "run.failed",
  "run.cancelled",
  "run.interrupted",
];

export const createRequestsService = ({
  atomic,
  clock,
  db,
  events,
  runs,
  secrets,
}: {
  atomic: Atomic;
  clock: Clock;
  db: Database;
  events: EventsService;
  runs: RunsService;
  secrets: Pick<SecretsService, "maskerFor">;
}) => {
  const requireRun = async (principal: Principal, runId: string) => {
    const run = await loadRun(
      db,
      runId,
      principal.kind === "system" ? undefined : principal.workspaceId
    );
    if (!run) {
      throw new ServiceError("not_found", "Run not found");
    }
    authorize(principal, "requests.read", {
      id: run.id,
      kind: "run",
      workspaceId: run.workspaceId,
    });
    return run;
  };
  const writer = (principal: Principal, run: RunRecord) => {
    authorize(principal, "requests.write", {
      id: run.id,
      kind: "run",
      workspaceId: run.workspaceId,
    });
    if (
      !(
        principal.kind === "system" ||
        (principal.kind === "machine" && principal.machineId === run.claimedBy)
      )
    ) {
      throw new ForbiddenError("requests.write");
    }
  };
  const visible = async (principal: Principal, sessionId: string) => {
    if (principal.kind !== "user") {
      throw new ForbiddenError("requests.answer");
    }
    const [session] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(eq(sessions.id, sessionId), await visibleSessions(db, principal))
      );
    if (!session) {
      throw new ServiceError("not_found", "Request not found");
    }
  };
  const requireRequest = async (principal: Principal, requestId: string) => {
    const [row] = await db
      .select()
      .from(runRequests)
      .where(
        and(
          eq(runRequests.id, requestId),
          principal.kind === "system"
            ? undefined
            : eq(runRequests.workspaceId, principal.workspaceId)
        )
      );
    if (!row) {
      throw new ServiceError("not_found", "Request not found");
    }
    const run = await requireRun(principal, row.runId);
    if (principal.kind === "user") {
      await visible(principal, run.sessionId);
    } else {
      writer(principal, run);
    }
    return { row, run };
  };
  const announce = (
    row: RequestRow,
    type: EventInput["type"],
    payload: Record<string, unknown> = {},
    userId?: string
  ) =>
    events.append({
      actor: userId
        ? { id: userId, kind: "user" }
        : { id: row.agentId, kind: "agent" },
      agentId: row.agentId,
      payload: { requestId: row.id, ...payload },
      runId: row.runId,
      sessionId: row.sessionId,
      type,
      workspaceId: row.workspaceId,
    });
  const ruleAgent = async (principal: Principal, agentId: string) => {
    if (principal.kind !== "user") {
      throw new ForbiddenError("requests.rules");
    }
    authorize(principal, "requests.rules", {
      id: agentId,
      kind: "agent",
      workspaceId: principal.workspaceId,
    });
    const agent = await findAgent(db, {
      id: agentId,
      workspaceId: principal.workspaceId,
    });
    if (!agent) {
      throw new ServiceError("not_found", "Agent not found");
    }
    return { agent, user: principal };
  };
  const listRules = async (
    principal: Principal,
    raw: z.input<typeof rulesListInputSchema>
  ) => {
    const input = rulesListInputSchema.parse(raw);
    const { agent } = await ruleAgent(principal, input.agentId);
    return await db
      .select()
      .from(agentToolRules)
      .where(
        and(
          eq(agentToolRules.agentId, agent.id),
          eq(agentToolRules.workspaceId, agent.workspaceId)
        )
      )
      .orderBy(agentToolRules.toolKey);
  };
  const setRule = async (
    principal: Principal,
    raw: z.input<typeof ruleSetInputSchema>
  ) => {
    const input = ruleSetInputSchema.parse(raw);
    const { agent, user } = await ruleAgent(principal, input.agentId);
    const row = {
      ...input,
      id: ulid(),
      updatedAt: clock.now().toISOString(),
      updatedBy: user.userId,
      workspaceId: agent.workspaceId,
    };
    await atomic([
      db
        .insert(agentToolRules)
        .values(row)
        .onConflictDoUpdate({
          set: {
            mode: row.mode,
            updatedAt: row.updatedAt,
            updatedBy: row.updatedBy,
          },
          target: [agentToolRules.agentId, agentToolRules.toolKey],
        }),
    ]);
    await events.append({
      actor: { id: user.userId, kind: "user" },
      agentId: agent.id,
      payload: input,
      type: "tool_rule.changed",
      workspaceId: agent.workspaceId,
    });
  };
  const removeRule = async (
    principal: Principal,
    raw: z.input<typeof ruleKeyInputSchema>
  ) => {
    const input = ruleKeyInputSchema.parse(raw);
    const { agent, user } = await ruleAgent(principal, input.agentId);
    await db
      .delete(agentToolRules)
      .where(
        and(
          eq(agentToolRules.agentId, agent.id),
          eq(agentToolRules.toolKey, input.toolKey),
          eq(agentToolRules.workspaceId, agent.workspaceId)
        )
      );
    await events.append({
      actor: { id: user.userId, kind: "user" },
      agentId: agent.id,
      payload: { ...input, mode: null },
      type: "tool_rule.changed",
      workspaceId: agent.workspaceId,
    });
  };
  const needsApproval = async (
    principal: Principal,
    input: { runId: string; toolKey: string }
  ) => {
    const run = await requireRun(principal, input.runId);
    if (principal.kind === "user") {
      await visible(principal, run.sessionId);
    } else {
      writer(principal, run);
    }
    const [rule] = await db
      .select()
      .from(agentToolRules)
      .where(
        and(
          eq(agentToolRules.agentId, run.agentId),
          eq(agentToolRules.toolKey, input.toolKey),
          eq(agentToolRules.workspaceId, run.workspaceId)
        )
      );
    return rule?.mode === "ask";
  };
  const markRunningIfSettled = async (runId: string) => {
    const [pending] = await db
      .select({ id: runRequests.id })
      .from(runRequests)
      .where(
        and(eq(runRequests.runId, runId), eq(runRequests.status, "pending"))
      )
      .limit(1);
    if (!pending) {
      await runs.markRunning(SYSTEM_PRINCIPAL, runId);
    }
  };
  const approvalToolKey = async (
    run: RunRecord,
    input: z.infer<typeof openInputSchema>
  ) => {
    if (input.kind !== "approval") {
      return "";
    }
    if (input.toolKey) {
      return input.toolKey;
    }
    const agent = await findAgent(db, {
      id: run.agentId,
      workspaceId: run.workspaceId,
    });
    return canonicalToolKey({
      name: input.toolName,
      runtime: agent?.runtime ?? "machine",
    });
  };
  const open = async (
    principal: Principal,
    raw: z.input<typeof openInputSchema>
  ) => {
    const input = openInputSchema.parse(raw);
    const run = await requireRun(principal, input.runId);
    writer(principal, run);
    const key = and(
      eq(runRequests.runId, run.id),
      eq(runRequests.toolUseId, input.toolUseId)
    );
    const [existing] = await db.select().from(runRequests).where(key);
    if (existing) {
      return requestRecord(existing);
    }
    if (!["running", "waiting"].includes(run.status)) {
      throw new ServiceError("conflict", "Run is not running");
    }
    // Keep the shared masker convention: granted values display as [secret:NAME].
    const masker = await secrets.maskerFor(run.workspaceId, run.agentId);
    const clean =
      input.kind === "approval"
        ? redactToolPayload(masker?.maskDeep(input.input) ?? input.input)
        : null;
    const toolKey = await approvalToolKey(run, input);
    const display =
      input.kind === "approval"
        ? {
            input: capInput(clean as NonNullable<typeof clean>),
            summary: approvalSummary(input.toolName, clean),
            toolKey,
            toolName: input.toolName,
          }
        : {
            questions: input.questions.map((question) => ({
              ...question,
              ...(question.choices && {
                choices: question.choices.map((choice) =>
                  scrubText(masker, choice)
                ),
              }),
              ...(question.header !== undefined && {
                header: scrubText(masker, question.header),
              }),
              question: scrubText(masker, question.question),
            })),
          };
    const now = clock.now();
    const [row] = await db
      .insert(runRequests)
      .values({
        agentId: run.agentId,
        createdAt: now.toISOString(),
        display: JSON.stringify(display),
        expiresAt: new Date(
          now.getTime() +
            (input.kind === "approval" ? APPROVAL_TTL_MS : QUESTION_TTL_MS)
        ).toISOString(),
        id: ulid(),
        kind: input.kind,
        // The runtime's own question texts; answers come back keyed by them.
        questionKeys:
          input.kind === "question"
            ? JSON.stringify(input.questions.map(({ question }) => question))
            : null,
        runId: run.id,
        sessionId: run.sessionId,
        status: "pending",
        toolKey: input.kind === "approval" ? toolKey : null,
        toolName: input.toolName,
        toolUseId: input.toolUseId,
        workspaceId: run.workspaceId,
      })
      .onConflictDoNothing({
        target: [runRequests.runId, runRequests.toolUseId],
      })
      .returning();
    if (!row) {
      const [winner] = await db.select().from(runRequests).where(key);
      if (!winner) {
        throw new ServiceError("not_found", "Request not found");
      }
      return requestRecord(winner);
    }
    await announce(row, "request.opened", {
      display,
      expiresAt: row.expiresAt,
      kind: row.kind,
      toolKey: row.toolKey,
      toolName: row.toolName,
      toolUseId: row.toolUseId,
    });
    await runs.markWaiting(SYSTEM_PRINCIPAL, run.id);
    // An append listener can answer before markWaiting; reconcile without delivering twice.
    await markRunningIfSettled(run.id);
    return requestRecord(row);
  };
  const resume = async (row: RequestRow) => {
    await markRunningIfSettled(row.runId);
    // Each closed request needs delivery even while another keeps the run waiting.
    await runs.resumeRequest(SYSTEM_PRINCIPAL, row.runId, requestRecord(row));
  };
  const answer = async (
    principal: Principal,
    raw: z.input<typeof answerInputSchema>
  ) => {
    const input = answerInputSchema.parse(raw);
    const { row } = await requireRequest(principal, input.requestId);
    if (principal.kind !== "user") {
      throw new ForbiddenError("requests.answer");
    }
    const parsed =
      row.kind === "approval"
        ? approvalAnswerSchema.parse(input.answer)
        : questionAnswerSchema.parse(input.answer);
    const masker = await secrets.maskerFor(row.workspaceId, row.agentId);
    // The row keeps what the person typed, which the runtime hands to the
    // model. Only the event and the clients' records are scrubbed.
    const stored = "answers" in parsed ? runtimeAnswers(row, parsed) : parsed;
    const clean = scrubAnswer(parsed, masker);
    const [closed] = await db
      .update(runRequests)
      .set({
        answer: JSON.stringify(stored),
        answeredAt: clock.now().toISOString(),
        answeredBy: principal.userId,
        answeredVia: input.via,
        status: "answered",
      })
      .where(and(eq(runRequests.id, row.id), eq(runRequests.status, "pending")))
      .returning();
    if (!closed) {
      throw new ServiceError("conflict", "Already answered");
    }
    if (
      "decision" in parsed &&
      parsed.decision === "always_allow" &&
      row.toolKey
    ) {
      await setRule(principal, {
        agentId: row.agentId,
        mode: "allow",
        toolKey: row.toolKey,
      });
    }
    await announce(
      closed,
      "request.answered",
      { ...clean, answeredBy: principal.userId, via: input.via },
      principal.userId
    );
    await resume(closed);
    return scrubbedRecord(closed, masker);
  };
  const outcome = async (principal: Principal, requestId: string) =>
    outcomeOf((await requireRequest(principal, requestId)).row);
  const waitForOutcome = async (
    principal: Principal,
    requestId: string,
    { waitMs }: { waitMs: number }
  ) => {
    const deadline =
      clock.now().getTime() + Math.min(Math.max(waitMs, 0), 25_000);
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential long polling
      const result = await outcome(principal, requestId);
      const remaining = deadline - clock.now().getTime();
      if (result || remaining <= 0) {
        return result;
      }
      await clock.sleep(Math.min(WAIT_POLL_MS, remaining));
    }
  };
  const expireDue = async (principal: Principal) => {
    if (principal.kind !== "system") {
      throw new ForbiddenError("requests.expire");
    }
    const closed = await db
      .update(runRequests)
      .set({ status: "expired" })
      .where(
        and(
          eq(runRequests.status, "pending"),
          lte(runRequests.expiresAt, clock.now().toISOString())
        )
      )
      .returning();
    for (const row of closed) {
      // biome-ignore lint/performance/noAwaitInLoops: notify before waking each runtime
      await announce(row, "request.expired");
      await resume(row);
    }
  };
  // Terminal runs have already stopped their runtime; cancellation never wakes it.
  const cancelForRun = async (run: RunRecord) => {
    const closed = await db
      .update(runRequests)
      .set({ status: "cancelled" })
      .where(
        and(
          eq(runRequests.runId, run.id),
          eq(runRequests.workspaceId, run.workspaceId),
          eq(runRequests.status, "pending")
        )
      )
      .returning();
    for (const row of closed) {
      // biome-ignore lint/performance/noAwaitInLoops: ordered cancellation events
      await announce(row, "request.cancelled");
    }
  };
  runs.onEvent(async (event) => {
    if (ended.includes(event.type) && event.runId) {
      const run = await loadRun(db, event.runId, event.workspaceId);
      if (run) {
        await cancelForRun(run);
      }
    }
  });
  const listPending = async (
    principal: Principal,
    raw: z.input<typeof pendingInputSchema> = {}
  ) => {
    const input = pendingInputSchema.parse(raw);
    if (principal.kind !== "user") {
      throw new ForbiddenError("requests.pending");
    }
    authorize(principal, "requests.read", {
      kind: "request",
      workspaceId: principal.workspaceId,
    });
    const visibleIds = db
      .select({ id: sessions.id })
      .from(sessions)
      .where(await visibleSessions(db, principal));
    const rows = await db
      .select()
      .from(runRequests)
      .where(
        and(
          eq(runRequests.workspaceId, principal.workspaceId),
          eq(runRequests.status, "pending"),
          inArray(runRequests.sessionId, visibleIds),
          input.sessionId
            ? eq(runRequests.sessionId, input.sessionId)
            : undefined
        )
      )
      .orderBy(runRequests.createdAt, runRequests.id);
    // A pending request has no answer yet, so there is nothing to mask.
    return rows.map((row) => scrubbedRecord(row, null));
  };
  return {
    answer,
    cancelForRun,
    expireDue,
    listPending,
    listRules,
    needsApproval,
    open,
    outcome,
    removeRule,
    setRule,
    waitForOutcome,
  };
};

export type RequestsService = ReturnType<typeof createRequestsService>;
