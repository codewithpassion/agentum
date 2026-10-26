/**
 * The desk as an outside app sees it (contract C4, `/api/desk/*`): what waits
 * on a person, a decision on it, and a message to the workspace's controller.
 * Thin over the requests and runs services. The outside app holds an `hm_key_`
 * key with the `desk` scope and names the member it acts for by email. A
 * connected app's OAuth token is refused: any approved MCP app would gain a
 * person's power to answer approvals. The member's own token on the shared
 * Clerk instance waits for a way to tell flightdex's client from the rest.
 */
import type { Database } from "@repo/db";
import { agents as agentRows } from "@repo/db/schema/agents";
import { runRequests } from "@repo/db/schema/requests";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { workspaces } from "@repo/db/schema/workspaces";
import { questionDisplaySchema } from "@repo/protocol/requests";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { AgentsService } from "./agents.ts";
import { authorize, ForbiddenError } from "./authz.ts";
import { isReadOnly } from "./automation-access.ts";
import { ServiceError } from "./errors.ts";
import type { RequestRecord, RequestsService } from "./requests.ts";
import { type Clock, INPUT_TEXT_MAX } from "./runs/types.ts";
import type { RunsService } from "./runs.ts";
import { visibleSessions } from "./sessions.ts";
import type { Principal } from "./workspaces.ts";

/** The agent that receives controller messages, by name and ignoring case. */
export const CONTROLLER_AGENT_NAME = "controller";

/** Longest `detail` an item carries. */
const DETAIL_MAX = 2000;

const DECIDE_ACTION = "desk.decide";
const MEMBER_ACTION = "desk.member";
const SCOPE_ACTION = "desk.scope";
const WRITE_ACTION = "desk.write";

const idString = z.string().min(1).max(200);

export const deskDecisionInputSchema = z.strictObject({
  answer: z.string().max(INPUT_TEXT_MAX).optional(),
  decision: z.enum(["allow_once", "always", "deny"]),
});
export type DeskDecisionInput = z.input<typeof deskDecisionInputSchema>;

export const deskMessageInputSchema = z.strictObject({
  text: z.string().trim().min(1).max(INPUT_TEXT_MAX),
  threadId: idString.optional(),
});
export type DeskMessageInput = z.input<typeof deskMessageInputSchema>;

/**
 * The Clerk user id of the member of Clerk organisation `clerkOrgId` whose
 * verified email is `email`, or null when there is none. The app implements it
 * with Clerk.
 */
export type MemberDirectory = (
  email: string,
  clerkOrgId: string
) => Promise<string | null>;

type UserPrincipal = Extract<Principal, { kind: "user" }>;

/** One thing waiting on the member, as C4 lists it. */
export interface NeedsYouItem {
  agent: string;
  createdAt: string;
  detail: string;
  expiresAt: string;
  kind: "approval" | "question";
  requestId: string;
  runId: string;
  title: string;
}

const clip = (text: string): string =>
  text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX - 1)}…` : text;

/** Title and detail from the stored, already scrubbed display. */
const describe = (record: RequestRecord): { detail: string; title: string } => {
  const { display } = record;
  if ("questions" in display) {
    const [first] = display.questions;
    return {
      detail: clip(
        display.questions
          .map(({ choices, question }) =>
            choices?.length ? `${question} (${choices.join(" / ")})` : question
          )
          .join("\n")
      ),
      title: clip(first?.header ?? first?.question ?? "Question"),
    };
  }
  return {
    detail: clip(
      typeof display.input === "string"
        ? display.input
        : JSON.stringify(display.input, null, 2)
    ),
    title: display.summary,
  };
};

export const createDeskApiService = ({
  agents,
  clock,
  db,
  directory,
  requests,
  runs,
}: {
  agents: Pick<AgentsService, "list">;
  clock: Clock;
  db: Database;
  directory: MemberDirectory;
  requests: Pick<RequestsService, "answer" | "listPending" | "outcome">;
  runs: Pick<RunsService, "startRun">;
}) => {
  /**
   * The member a request acts for. A desk key acts for the member its
   * `X-On-Behalf-Of` email names, who must belong to the key's workspace. Any
   * other credential is refused.
   */
  const actingMember = async (
    credential: Principal,
    email: string | null
  ): Promise<UserPrincipal> => {
    if (credential.kind !== "user") {
      throw new ForbiddenError(SCOPE_ACTION);
    }
    if (credential.via !== "api_key" || credential.apiKey?.access !== "desk") {
      throw new ForbiddenError(SCOPE_ACTION);
    }
    const address = email?.trim() ?? "";
    if (address === "") {
      throw new ForbiddenError(MEMBER_ACTION);
    }
    const [workspace] = await db
      .select({ clerkOrgId: workspaces.clerkOrgId })
      .from(workspaces)
      .where(eq(workspaces.id, credential.workspaceId))
      .limit(1);
    const userId = workspace
      ? await directory(address, workspace.clerkOrgId)
      : null;
    if (userId === null) {
      throw new ForbiddenError(MEMBER_ACTION);
    }
    return { ...credential, userId };
  };

  const requireWriter = (member: UserPrincipal, action: string) => {
    if (isReadOnly(member)) {
      throw new ForbiddenError(action);
    }
  };

  /** What waits on the member now, oldest first. A request past its expiry is left out. */
  const needsYou = async (member: UserPrincipal): Promise<NeedsYouItem[]> => {
    const now = clock.now().toISOString();
    const pending = (await requests.listPending(member)).filter(
      (record) => record.expiresAt > now
    );
    if (pending.length === 0) {
      return [];
    }
    const named = await db
      .select({ id: agentRows.id, name: agentRows.name })
      .from(agentRows)
      .where(
        and(
          eq(agentRows.workspaceId, member.workspaceId),
          inArray(agentRows.id, [...new Set(pending.map((r) => r.agentId))])
        )
      );
    const names = new Map(named.map((agent) => [agent.id, agent.name]));
    return pending.map((record) => ({
      agent: names.get(record.agentId) ?? record.agentId,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      kind: record.kind,
      requestId: record.id,
      runId: record.runId,
      ...describe(record),
    }));
  };

  /**
   * True when the member may see the run: it is in a session the requests
   * list admits (`visibleSessions`). The stream asks it per frame, so another
   * member's ui session or private DM never reaches this member's desk.
   */
  const canSeeRun = async (
    member: UserPrincipal,
    runId: string
  ): Promise<boolean> => {
    authorize(member, "requests.read", {
      kind: "request",
      workspaceId: member.workspaceId,
    });
    const [row] = await db
      .select({ id: runRows.id })
      .from(runRows)
      .where(
        and(
          eq(runRows.id, runId),
          eq(runRows.workspaceId, member.workspaceId),
          inArray(
            runRows.sessionId,
            db
              .select({ id: sessions.id })
              .from(sessions)
              .where(await visibleSessions(db, member))
          )
        )
      )
      .limit(1);
    return row !== undefined;
  };

  /** The answer to a question request, in the shape the requests service takes. */
  const questionAnswer = (
    display: unknown,
    input: z.output<typeof deskDecisionInputSchema>
  ) => {
    const { questions } = questionDisplaySchema.parse(display);
    const [only] = questions;
    if (questions.length !== 1 || !only) {
      throw new ServiceError(
        "invalid",
        "This request has several questions. Answer it in Harbourmaster."
      );
    }
    const text =
      input.answer?.trim() || (input.decision === "deny" ? "Declined." : "");
    if (text === "") {
      throw new ServiceError("invalid", "A question needs an answer.");
    }
    return { answers: { [only.question]: text } };
  };

  /**
   * Answers a request as the member, like a decision on the web. The first
   * answer wins: a request already answered (here, on the web or in Slack)
   * is a conflict.
   */
  const decide = async (
    member: UserPrincipal,
    requestId: string,
    rawInput: DeskDecisionInput
  ): Promise<{ requestId: string; status: "answered" }> => {
    requireWriter(member, DECIDE_ACTION);
    const id = idString.parse(requestId);
    const input = deskDecisionInputSchema.parse(rawInput);
    // The requests service hides a request in a session the member cannot see
    // (not found), before the body decides anything.
    await requests.outcome(member, id);
    const [row] = await db
      .select({ display: runRequests.display, kind: runRequests.kind })
      .from(runRequests)
      .where(
        and(
          eq(runRequests.id, id),
          eq(runRequests.workspaceId, member.workspaceId)
        )
      )
      .limit(1);
    if (!row) {
      throw new ServiceError("not_found", "Request not found");
    }
    const answer =
      row.kind === "approval"
        ? {
            decision:
              input.decision === "always"
                ? ("always_allow" as const)
                : input.decision,
            ...(input.answer ? { note: input.answer } : {}),
          }
        : questionAnswer(JSON.parse(row.display), input);
    await requests.answer(member, { answer, requestId: id, via: "web" });
    return { requestId: id, status: "answered" };
  };

  /**
   * Sends text to the workspace's controller agent, the active agent named
   * `controller`. A `threadId` continues that conversation, as the same session.
   */
  const sendToController = async (
    member: UserPrincipal,
    rawInput: DeskMessageInput
  ): Promise<{ runId: string; sessionId: string }> => {
    requireWriter(member, WRITE_ACTION);
    const input = deskMessageInputSchema.parse(rawInput);
    const controller = (await agents.list(member)).find(
      (agent) => agent.name.toLowerCase() === CONTROLLER_AGENT_NAME
    );
    if (!controller) {
      throw new ServiceError(
        "not_found",
        "This workspace has no controller agent"
      );
    }
    const started = await runs.startRun(member, {
      agentId: controller.id,
      input: { text: input.text },
      session: { externalKey: input.threadId, origin: "ui" },
    });
    return { runId: started.runId, sessionId: started.sessionId };
  };

  return { actingMember, canSeeRun, decide, needsYou, sendToController };
};

export type DeskApiService = ReturnType<typeof createDeskApiService>;
