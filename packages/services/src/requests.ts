import type { Database } from "@repo/db";
import type { Atomic } from "@repo/db/atomic";
import { a2aConnections } from "@repo/db/schema/a2a";
import { agents } from "@repo/db/schema/agents";
import { runRequests } from "@repo/db/schema/requests";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { agentToolRules } from "@repo/db/schema/tool-rules";
import {
  APPROVAL_TTL_MS,
  type ComputerTakeoverRequestedPayload,
  PEER_QUESTION_TTL_MS,
  QUESTION_TTL_MS,
  TAKEOVER_TTL_MS,
  TOOL_RULE_MODES,
} from "@repo/db/shared";
import {
  approvalAnswerSchema,
  approvalSummary,
  toolKey as canonicalToolKey,
  questionAnswerSchema,
  questionDisplaySchema,
} from "@repo/protocol/requests";
import { and, eq, getTableColumns, inArray, lte, sql } from "drizzle-orm";
import { ulid } from "ulidx";
import { z } from "zod";
import { findAgent } from "./agents.ts";
import { authorize, ForbiddenError } from "./authz.ts";
import { ServiceError } from "./errors.ts";
import { redactToolPayload } from "./events/scrub.ts";
import type { EventInput, EventsService } from "./events.ts";
import {
  isDetachedApproval,
  isPromoteApproval,
  mailSendError,
  notDetachedApproval,
} from "./mail/approval.ts";
import { askKeysOf } from "./requests/ask-keys.ts";
import {
  approvedDecision,
  canonicalEffect,
  matchesEffectApproval,
} from "./requests/outbound.ts";
import {
  answerInputSchema,
  answerSchemas,
  capInput,
  openInputSchema,
  outcomeOf,
  type RequestRecord,
  type RequestRow,
  requestRecord,
  runtimeAnswers,
  scrubAnswer,
  scrubbedRecord,
  scrubText,
} from "./requests/records.ts";
import { importRunTokenKey } from "./run-tokens.ts";
import { currentGuestRun, guestUnavailable } from "./runs/guest-scope.ts";
import { peerRootOf, peerRootsOf } from "./runs/peer-root.ts";
import { loadRun } from "./runs/queries.ts";
import type { Clock, RunRecord } from "./runs/types.ts";
import type { RunsService } from "./runs.ts";
import type { SecretsService } from "./secrets.ts";
import { visibleSessions } from "./sessions.ts";
import { buildPeerEnvelope } from "./speaker-envelope.ts";
import { type Principal, SYSTEM_PRINCIPAL } from "./workspaces.ts";

export type { RequestRecord } from "./requests/records.ts";

const id = z.string().min(1).max(200);
export const pendingInputSchema = z.strictObject({ sessionId: id.optional() });
export const rulesListInputSchema = z.strictObject({ agentId: id });
export const ruleKeyInputSchema = rulesListInputSchema.extend({ toolKey: id });
export const ruleSetInputSchema = ruleKeyInputSchema.extend({
  mode: z.enum(TOOL_RULE_MODES),
});
/** As long as a message a peer may send, so an answer is never refused for its length alone. */
const PEER_ANSWER_MAX = 30_000;
const UNKNOWN_PEER_HOST = "unknown host";

export const peerAnswerInputSchema = z.strictObject({
  requestId: id,
  text: z.string().trim().min(1).max(PEER_ANSWER_MAX),
});

const peerHost = (origin: string | null): string => {
  try {
    return origin === null ? UNKNOWN_PEER_HOST : new URL(origin).host;
  } catch {
    return UNKNOWN_PEER_HOST;
  }
};
export const webAnswerInputSchema = z.union([
  approvalAnswerSchema.extend({ requestId: id }),
  questionAnswerSchema.extend({ requestId: id }),
]);

const TTL = {
  approval: APPROVAL_TTL_MS,
  question: QUESTION_TTL_MS,
  takeover: TAKEOVER_TTL_MS,
};
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
  guestPresence,
  runTokenKey,
}: {
  runTokenKey?: string;
  guestPresence?: (scope: {
    artifactId: string;
    workspaceId: string;
  }) => Promise<boolean>;
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
    if (run.scopeArtifactId) {
      await runs.authorizeScopedRun(principal, run.id);
    }
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
        (principal.kind === "run" &&
          principal.runId === run.id &&
          principal.agentId === run.agentId &&
          ["running", "waiting"].includes(run.status)) ||
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
        and(
          eq(sessions.id, sessionId),
          await visibleSessions(db, principal, clock.now().toISOString())
        )
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
    userId?: string,
    peerConnectionId?: string
  ) =>
    events.append({
      actor: announcer(row, userId, peerConnectionId),
      agentId: row.agentId,
      payload: { requestId: row.id, ...payload },
      runId: row.runId,
      sessionId: row.sessionId,
      type,
      workspaceId: row.workspaceId,
    });
  const announcer = (
    row: RequestRow,
    userId?: string,
    peerConnectionId?: string
  ): { id: string; kind: "agent" | "peer" | "user" } => {
    if (peerConnectionId) {
      return { id: peerConnectionId, kind: "peer" };
    }
    return userId
      ? { id: userId, kind: "user" }
      : { id: row.agentId, kind: "agent" };
  };
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
  const guestsPresent = async (run: RunRecord) => {
    const [session] = await db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.id, run.sessionId),
          eq(sessions.workspaceId, run.workspaceId)
        )
      )
      .limit(1);
    if (session?.origin !== "artifact" || !session.externalKey) {
      return false;
    }
    const [sourceVisible] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.id, run.sessionId),
          await visibleSessions(
            db,
            {
              agentId: run.agentId,
              kind: "run",
              runId: run.id,
              workspaceId: run.workspaceId,
            },
            clock.now().toISOString()
          )
        )
      )
      .limit(1);
    if (!sourceVisible) {
      throw new ForbiddenError("requests.sourceUnavailable");
    }
    return (
      !guestPresence ||
      (await guestPresence({
        artifactId: session.externalKey,
        workspaceId: run.workspaceId,
      }))
    );
  };
  /**
   * A run a peer started, one it handed work to, or a wake carrying its answer
   * asks for every tool while that peer's connection has `tool_policy = ask`.
   * The whole chain counts: one link that asks, or has ended, makes the run ask.
   * A peer's text is outside input, so a connection that is gone or ended asks
   * too: only an active connection set to `agent_rules` opens the agent's own
   * rules.
   */
  const peerAsksEveryTool = async (run: RunRecord): Promise<boolean> => {
    const connectionIds = await peerRootsOf(db, run);
    if (connectionIds.length === 0) {
      return false;
    }
    const trusting = await db
      .select({ id: a2aConnections.id })
      .from(a2aConnections)
      .where(
        and(
          inArray(a2aConnections.id, connectionIds),
          eq(a2aConnections.workspaceId, run.workspaceId),
          eq(a2aConnections.status, "active"),
          eq(a2aConnections.toolPolicy, "agent_rules")
        )
      );
    return (
      new Set(trusting.map((row) => row.id)).size < new Set(connectionIds).size
    );
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
    if (run.scopeArtifactId) {
      return true;
    }
    if (await guestsPresent(run)) {
      return true;
    }
    if (await peerAsksEveryTool(run)) {
      return true;
    }
    // The ask keys include the platform tools a switch covers (SWITCH_COVERS).
    return (
      await askKeysOf(db, { id: run.agentId, workspaceId: run.workspaceId })
    ).includes(input.toolKey);
  };
  const markRunningIfSettled = async (runId: string) => {
    const [pending] = await db
      .select({ id: runRequests.id })
      .from(runRequests)
      .where(
        and(
          eq(runRequests.runId, runId),
          eq(runRequests.status, "pending"),
          notDetachedApproval
        )
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
  const takeoverComputer = async (run: RunRecord) => {
    const [agent] = await db
      .select({ computerMachineId: agents.computerMachineId })
      .from(agents)
      .where(
        and(eq(agents.id, run.agentId), eq(agents.workspaceId, run.workspaceId))
      );
    const computerMachineId = agent?.computerMachineId ?? null;
    if (!computerMachineId) {
      throw new ServiceError("conflict", "Agent has no computer");
    }
    return computerMachineId;
  };
  const effectBinding = async (
    run: RunRecord,
    toolKey: string,
    input: unknown
  ) => {
    if (!runTokenKey) {
      return;
    }
    const bytes = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        await importRunTokenKey(runTokenKey),
        new TextEncoder().encode(
          `outbound-receipt:${canonicalEffect([run.id, toolKey, input])}`
        )
      )
    );
    return [...bytes]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  };
  const prepareOpen = async (
    run: RunRecord,
    input: z.infer<typeof openInputSchema>
  ): Promise<RequestRecord["display"]> => {
    if (run.scopeArtifactId && input.kind === "takeover") {
      throw guestUnavailable();
    }
    const masker = await secrets.maskerFor(run.workspaceId, run.agentId);
    const toolKey = await approvalToolKey(run, input);
    if (input.kind === "takeover") {
      // A message from outside has no business asking a person to take over a computer.
      if ((await peerRootsOf(db, run)).length > 0) {
        throw new ServiceError(
          "conflict",
          "A takeover can't be requested in work that started with a message from a peer"
        );
      }
      return {
        machineId: await takeoverComputer(run),
        reason: scrubText(masker, input.reason),
      };
    }
    if (input.kind === "approval") {
      const clean = redactToolPayload(
        masker?.maskDeep(input.input) ?? input.input
      );
      const binding = await effectBinding(run, toolKey, input.input);
      const peerRun = (await peerRootsOf(db, run)).length > 0;
      return {
        ...(binding ? { effectBinding: binding } : {}),
        input: capInput(clean),
        ...(peerRun ? { peerRun: true } : {}),
        summary: approvalSummary(input.toolName, clean),
        toolKey,
        toolName: input.toolName,
      };
    }
    return {
      questions: input.questions.map((question) => ({
        ...question,
        ...(question.choices && {
          choices: question.choices.map((choice) => scrubText(masker, choice)),
        }),
        ...(question.header !== undefined && {
          header: scrubText(masker, question.header),
        }),
        question: scrubText(masker, question.question),
      })),
    };
  };
  const insertPending = (row: RequestRow, run: RunRecord) => {
    if (run.scopeArtifactId) {
      const keys = Object.keys(
        getTableColumns(runRequests)
      ) as (keyof RequestRow)[];
      return db
        .insert(runRequests)
        .select(sql`select ${sql.join(
          keys.map((key) => sql`${row[key]}`),
          sql`, `
        )}
        where exists (select 1 from ${runRows} where ${runRows.id} = ${run.id} and ${currentGuestRun(clock.now().toISOString())})`)
        .onConflictDoNothing({
          target: [runRequests.runId, runRequests.toolUseId],
        })
        .returning();
    }
    if (row.kind !== "takeover") {
      return db
        .insert(runRequests)
        .values(row)
        .onConflictDoNothing({
          target: [runRequests.runId, runRequests.toolUseId],
        })
        .returning();
    }
    // Test exclusivity in the insert statement so concurrent runtimes cannot
    // both open a takeover. The refinement defines exclusivity per agent.
    const keys = Object.keys(
      getTableColumns(runRequests)
    ) as (keyof RequestRow)[];
    return db
      .insert(runRequests)
      .select(sql`select ${sql.join(
        keys.map((key) => sql`${row[key]}`),
        sql`, `
      )}
      where not exists (select 1 from ${runRequests} where ${runRequests.agentId} = ${row.agentId} and ${runRequests.kind} = 'takeover' and ${runRequests.status} = 'pending')`)
      .onConflictDoNothing({
        target: [runRequests.runId, runRequests.toolUseId],
      })
      .returning();
  };
  const pendingConflict = (run: RunRecord) =>
    run.scopeArtifactId
      ? guestUnavailable()
      : new ServiceError("conflict", "A takeover is already pending");

  /** A question from a run a peer set going lapses sooner than a member's, so a peer cannot hold the agent for a day. */
  const ttlOf = async (
    run: RunRecord,
    kind: keyof typeof TTL
  ): Promise<number> =>
    kind === "question" && (await peerRootOf(db, run)) !== null
      ? PEER_QUESTION_TTL_MS
      : TTL[kind];

  const open = async (
    principal: Principal,
    raw: z.input<typeof openInputSchema>,
    options: { ttlMs?: number } = {}
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
    const display = await prepareOpen(run, input);
    const toolKey = "toolKey" in display ? display.toolKey : null;
    const now = clock.now();
    const [row] = await insertPending(
      {
        agentId: run.agentId,
        answer: null,
        answeredAt: null,
        answeredBy: null,
        answeredVia: null,
        createdAt: now.toISOString(),
        deliveredAt: null,
        display: JSON.stringify(display),
        expiresAt: new Date(
          now.getTime() + (options.ttlMs ?? (await ttlOf(run, input.kind)))
        ).toISOString(),
        id: ulid(),
        kind: input.kind,
        // The runtime's own question texts, unmasked on purpose: answers come
        // back keyed by them, so a masked key would leave the agent with no
        // answer. `display` is the masked copy. SE.3 left this open (see
        // docs/reviews/tasks/SE.3.md).
        questionKeys:
          input.kind === "question"
            ? JSON.stringify(input.questions.map(({ question }) => question))
            : null,
        runId: run.id,
        sessionId: run.sessionId,
        slackMessage: null,
        status: "pending",
        toolKey: input.kind === "approval" ? toolKey : null,
        toolName:
          input.kind === "takeover" ? "request_human_takeover" : input.toolName,
        toolUseId: input.toolUseId,
        workspaceId: run.workspaceId,
      },
      run
    );
    if (!row) {
      const [winner] = await db.select().from(runRequests).where(key);
      if (!winner) {
        throw pendingConflict(run);
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
    if ("machineId" in display) {
      const payload: ComputerTakeoverRequestedPayload = {
        ...display,
        requestId: row.id,
      };
      await announce(row, "computer.takeover_requested", { ...payload });
    }
    await waitForRuntime(row);
    return requestRecord(row);
  };
  const waitForRuntime = async (row: RequestRow) => {
    // Mail and promote approvals outlive the run; the tool returns immediately.
    if (isDetachedApproval(row)) {
      return;
    }
    await runs.markWaiting(SYSTEM_PRINCIPAL, row.runId);
    // An append listener may already have answered; reconcile its state.
    await markRunningIfSettled(row.runId);
  };
  const mayResume = async (row: RequestRow) => {
    const run = await loadRun(db, row.runId, row.workspaceId);
    if (!run?.scopeArtifactId) {
      return true;
    }
    try {
      await runs.authorizeScopedRun(SYSTEM_PRINCIPAL, run.id);
      return true;
    } catch (error) {
      if (error instanceof ForbiddenError) {
        return false;
      }
      throw error;
    }
  };
  const resume = async (row: RequestRow) => {
    if (isDetachedApproval(row)) {
      return;
    }
    if (!(await mayResume(row))) {
      return;
    }
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
    // A key must not turn its own proposed app's promote card into consent,
    // including through the desk API acting for the same user.
    if (isPromoteApproval(row) && principal.via !== "session") {
      throw new ForbiddenError("artifacts.decide_grant");
    }
    const parsed = answerSchemas[row.kind].parse(input.answer);
    if ("decision" in parsed && parsed.decision === "always_allow") {
      const run = await loadRun(db, row.runId, row.workspaceId);
      if (run && (await peerRootsOf(db, run)).length > 0) {
        throw new ServiceError(
          "invalid",
          "Always allow can't be set from work that started with a message from a peer. Allow it once instead."
        );
      }
    }
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
      .where(
        and(
          eq(runRequests.id, row.id),
          eq(runRequests.status, "pending"),
          inArray(
            runRequests.runId,
            db
              .select({ id: runRows.id })
              .from(runRows)
              .where(currentGuestRun(clock.now().toISOString()))
          ),
          inArray(
            runRequests.sessionId,
            db
              .select({ id: sessions.id })
              .from(sessions)
              .where(
                await visibleSessions(db, principal, clock.now().toISOString())
              )
          )
        )
      )
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
      {
        ...clean,
        answeredBy: principal.userId,
        kind: closed.kind,
        via: input.via,
      },
      principal.userId
    );
    await resume(closed);
    // The mail release ran inside `announce`, so a failure is stored by now.
    return {
      ...scrubbedRecord(closed, masker),
      sendError: await mailSendError(db, closed),
    };
  };
  /**
   * A peer answers a question its own run asked: the next message on the task
   * it started. Only a `question`, and only on a run this connection started,
   * so a peer can never answer an approval or reach another connection's run.
   * Its text answers every question the run asked.
   */
  const answerAsPeer = async (
    principal: Principal,
    raw: { requestId: string; text: string }
  ) => {
    if (principal.kind !== "peer") {
      throw new ForbiddenError("requests.answer");
    }
    const input = peerAnswerInputSchema.parse(raw);
    authorize(principal, "a2a.answer", {
      id: input.requestId,
      kind: "request",
      workspaceId: principal.workspaceId,
    });
    const [row] = await db
      .select()
      .from(runRequests)
      .where(
        and(
          eq(runRequests.id, input.requestId),
          eq(runRequests.workspaceId, principal.workspaceId),
          eq(runRequests.kind, "question")
        )
      );
    const run = row ? await loadRun(db, row.runId, row.workspaceId) : null;
    if (
      !(row && run) ||
      run.actor.kind !== "peer" ||
      run.actor.id !== principal.connectionId ||
      run.agentId !== principal.agentId ||
      // A run a peer started has no parent. A wake carries that peer's actor but sits under a run of ours, and no task links to it.
      run.parentRunId !== null
    ) {
      throw new ServiceError("not_found", "Request not found");
    }
    const questions = questionDisplaySchema.parse(JSON.parse(row.display));
    const answerOf = (text: string) => ({
      answers: Object.fromEntries(
        questions.questions.map(({ question }) => [question, text])
      ),
    });
    const parsed = answerOf(input.text);
    // The runtime hands the stored answer to the model as a tool result. The
    // peer's text goes through the envelope, so it never reads as a member's.
    const [connection] = await db
      .select({
        peerLabel: a2aConnections.peerLabel,
        peerOrigin: a2aConnections.peerOrigin,
      })
      .from(a2aConnections)
      .where(eq(a2aConnections.id, principal.connectionId))
      .limit(1);
    const enveloped = answerOf(
      buildPeerEnvelope(
        {
          agentName: connection?.peerLabel ?? "",
          connectionId: principal.connectionId,
          host: peerHost(connection?.peerOrigin ?? null),
        },
        input.text
      )
    );
    const masker = await secrets.maskerFor(row.workspaceId, row.agentId);
    const [closed] = await db
      .update(runRequests)
      .set({
        answer: JSON.stringify(runtimeAnswers(row, enveloped)),
        answeredAt: clock.now().toISOString(),
        answeredBy: principal.connectionId,
        answeredVia: "a2a",
        status: "answered",
      })
      .where(
        and(
          eq(runRequests.id, row.id),
          eq(runRequests.status, "pending"),
          inArray(
            runRequests.runId,
            db
              .select({ id: runRows.id })
              .from(runRows)
              .where(currentGuestRun(clock.now().toISOString()))
          )
        )
      )
      .returning();
    if (!closed) {
      throw new ServiceError("conflict", "Already answered");
    }
    await announce(
      closed,
      "request.answered",
      {
        ...scrubAnswer(parsed, masker),
        answeredBy: principal.connectionId,
        kind: closed.kind,
        via: "a2a",
      },
      undefined,
      principal.connectionId
    );
    await resume(closed);
  };
  const cancel = async (principal: Principal, requestId: string) => {
    const { row } = await requireRequest(principal, requestId);
    if (principal.kind !== "user") {
      throw new ForbiddenError("requests.answer");
    }
    const [closed] = await db
      .update(runRequests)
      .set({ status: "cancelled" })
      .where(
        and(
          eq(runRequests.id, row.id),
          eq(runRequests.status, "pending"),
          inArray(
            runRequests.runId,
            db
              .select({ id: runRows.id })
              .from(runRows)
              .where(currentGuestRun(clock.now().toISOString()))
          ),
          inArray(
            runRequests.sessionId,
            db
              .select({ id: sessions.id })
              .from(sessions)
              .where(
                await visibleSessions(db, principal, clock.now().toISOString())
              )
          )
        )
      )
      .returning();
    if (!closed) {
      throw new ServiceError("conflict", "Already answered");
    }
    await announce(closed, "request.cancelled", {}, principal.userId);
    await resume(closed);
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
  /** A peer's question that went unanswered ends its run, so the model cannot just ask again. */
  const endsRunWhenUnanswered = async (row: RequestRow): Promise<boolean> => {
    if (row.kind !== "question") {
      return false;
    }
    const run = await loadRun(db, row.runId, row.workspaceId);
    return run !== null && (await peerRootOf(db, run)) !== null;
  };
  const cancelUnanswered = async (row: RequestRow) => {
    try {
      await runs.cancelRun(SYSTEM_PRINCIPAL, row.runId);
    } catch (error) {
      // A conflict is a run that ended on its own in the meantime. Anything
      // else is logged, so one run that will not cancel does not stop the
      // sweep over the other expired requests.
      if (!(error instanceof ServiceError && error.code === "conflict")) {
        console.error(
          "Run not cancelled after its question expired",
          row.runId,
          error
        );
      }
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
      await announce(row, "request.expired", { kind: row.kind });
      if (await endsRunWhenUnanswered(row)) {
        await cancelUnanswered(row);
      } else {
        await resume(row);
      }
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
          notDetachedApproval,
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
      .where(await visibleSessions(db, principal, clock.now().toISOString()));
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
  const consumeApprovedEffect = async (
    run: RunRecord,
    toolKey: string,
    binding: string
  ) => {
    const candidates = await db
      .select()
      .from(runRequests)
      .where(
        and(
          eq(runRequests.runId, run.id),
          eq(runRequests.workspaceId, run.workspaceId),
          eq(runRequests.toolKey, toolKey),
          eq(runRequests.status, "answered")
        )
      );
    for (const row of candidates) {
      if (!matchesEffectApproval(row, binding)) {
        continue;
      }
      // biome-ignore lint/performance/noAwaitInLoops: only one approved receipt may be consumed.
      const taken = await db
        .update(runRequests)
        .set({ toolUseId: `consumed:${row.id}` })
        .where(
          and(
            eq(runRequests.id, row.id),
            eq(runRequests.toolUseId, row.toolUseId),
            eq(runRequests.status, "answered")
          )
        )
        .returning({ id: runRequests.id });
      if (taken.length) {
        return true;
      }
    }
    return false;
  };
  const requireOutbound = async (
    principal: Principal,
    toolKey: string,
    input: unknown
  ) => {
    if (principal.kind !== "run") {
      throw new ForbiddenError("requests.outboundRun");
    }
    const run = await requireRun(principal, principal.runId);
    writer(principal, run);
    if (outboundUnavailable(run)) {
      throw guestUnavailable();
    }
    if (!(await guestsPresent(run))) {
      return;
    }
    const binding = await effectBinding(run, toolKey, input);
    if (!binding) {
      throw new ForbiddenError("requests.outboundUnavailable");
    }
    if (await consumeApprovedEffect(run, toolKey, binding)) {
      return;
    }
    const digest = binding;
    const toolUseId = `outbound:${digest}`;
    const request = await open(principal, {
      input: {
        effect: z
          .record(z.string(), z.json())
          .parse(JSON.parse(JSON.stringify(input))),
      },
      kind: "approval",
      runId: run.id,
      toolKey,
      toolName: toolKey,
      toolUseId,
    });
    const receiptBinding = await effectBinding(run, toolKey, { effect: input });
    if (!validEffectReceipt(request.display, receiptBinding)) {
      throw new ForbiddenError("requests.outboundReceipt");
    }
    if (!approvedDecision(request.outcome)) {
      throw new ServiceError(
        "conflict",
        "Outbound effect requires a member approval in Needs you"
      );
    }
    const consumed = await db
      .update(runRequests)
      .set({ toolUseId: `consumed:${request.id}` })
      .where(
        and(
          eq(runRequests.id, request.id),
          eq(runRequests.runId, run.id),
          eq(runRequests.workspaceId, run.workspaceId),
          eq(runRequests.toolUseId, toolUseId),
          eq(runRequests.status, "answered")
        )
      )
      .returning({ id: runRequests.id });
    if (!consumed.length) {
      throw new ForbiddenError("requests.outboundConsumed");
    }
  };

  return {
    answer,
    answerAsPeer,
    cancel,
    cancelForRun,
    expireDue,
    listPending,
    listRules,
    needsApproval,
    open,
    outcome,
    removeRule,
    requireOutbound,
    requiresGuestApproval: async (principal: Principal, runId: string) => {
      const run = await requireRun(principal, runId);
      writer(principal, run);
      return Boolean(await guestsPresent(run));
    },
    setRule,
    waitForOutcome,
  };
};

export type RequestsService = ReturnType<typeof createRequestsService>;

const outboundUnavailable = (run: RunRecord) =>
  Boolean(run.scopeArtifactId) || !["running", "waiting"].includes(run.status);

const validEffectReceipt = (
  display: RequestRecord["display"],
  binding?: string
) => "effectBinding" in display && display.effectBinding === binding;
