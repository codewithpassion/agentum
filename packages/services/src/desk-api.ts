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
import type { DeskService } from "./desk.ts";
import { ServiceError } from "./errors.ts";
import type { RequestsService } from "./requests.ts";
import { INPUT_TEXT_MAX } from "./runs/types.ts";
import type { RunsService } from "./runs.ts";
import { visibleSessions } from "./sessions.ts";
import type { Principal } from "./workspaces.ts";

/** The agent that receives controller messages, by name and ignoring case. */
export const CONTROLLER_AGENT_NAME = "controller";

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

export type { NeedsYouItem } from "./desk.ts";

export const createDeskApiService = ({
  agents,
  db,
  desk,
  directory,
  requests,
  runs,
}: {
  agents: Pick<AgentsService, "list">;
  db: Database;
  desk: Pick<DeskService, "pendingRequests">;
  directory: MemberDirectory;
  requests: Pick<RequestsService, "answer" | "outcome">;
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
    if (row.kind === "takeover") {
      throw new ServiceError(
        "invalid",
        "Take over the computer in Harbourmaster."
      );
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

  /** What waits on the member now: the desk's pending requests. */
  const needsYou = (member: UserPrincipal) => desk.pendingRequests(member);

  return { actingMember, canSeeRun, decide, needsYou, sendToController };
};

export type DeskApiService = ReturnType<typeof createDeskApiService>;
