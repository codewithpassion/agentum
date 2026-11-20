/**
 * The lead role (TM.4). A lead coordinates its team: in a run woken by its team
 * room it posts to the room's topics, opens topics, lists its members and
 * proposes changes to them. It never writes a member. A proposal is an approval
 * request for the member's owner, and the change is applied only when that
 * person approves it (`proposal.ts`).
 */
import type { Database } from "@repo/db";
import { inboxThreads } from "@repo/db/schema/inbox";
import { runRequests } from "@repo/db/schema/requests";
import { memberProfiles, teamMembers } from "@repo/db/schema/teams";
import { SKILL_CHANGE_TTL_MS } from "@repo/db/shared";
import { and, asc, eq } from "drizzle-orm";
import { ulid } from "ulidx";
import { z } from "zod";
import {
  type AgentRecord,
  type AgentsService,
  assertModelForRuntime,
  findAgent,
} from "../agents.ts";
import { authorize, ForbiddenError } from "../authz.ts";
import { ServiceError } from "../errors.ts";
import { redactToolPayload } from "../events/scrub.ts";
import type { EventsService } from "../events.ts";
import { effectiveOwner } from "../guards.ts";
import { canReadTopic } from "../inbox/room-access.ts";
import type { InboxService, PostResult, ThreadRecord } from "../inbox.ts";
import type { RequestsService } from "../requests.ts";
import { loadRun } from "../runs/queries.ts";
import { idString } from "../shared.ts";
import { type Principal, SYSTEM_PRINCIPAL } from "../workspaces.ts";
import {
  isTeamProposal,
  PROPOSAL_INPUT_MAX_BYTES,
  type ProposalField,
  type ProposalInput,
  proposalOf,
  proposalValueSchemas,
  proposeInputSchema,
  TEAM_PROPOSAL_PREFIX,
  TEAM_PROPOSE_TOOL,
} from "./proposal.ts";
import { type LeadRoom, leadRoomOf } from "./room-run.ts";

const LEAD_ACTION = "teams.lead";
const TEAM_KIND = "team";
const TITLE_MAX = 120;
const MEMBERS_MAX = 50;

export const postTopicInputSchema = z.strictObject({
  text: z.string().trim().min(1),
  topic: idString,
});
export type PostTopicInput = z.input<typeof postTopicInputSchema>;

export const openTopicInputSchema = z.strictObject({
  members: z
    .array(z.strictObject({ id: idString, kind: z.enum(["agent", "user"]) }))
    .max(MEMBERS_MAX)
    .optional(),
  title: z.string().trim().min(1).max(TITLE_MAX),
});
export type OpenTopicInput = z.input<typeof openTopicInputSchema>;

/** A member of the lead's team. A person's `handle` is their `@handle`, an agent's is its slug. */
export interface LeadMember {
  contextBudget?: string;
  effort?: string;
  handle?: string;
  id: string;
  /** The agent's full current instructions. Agents only. */
  instructions?: string;
  isLead: boolean;
  kind: "agent" | "user";
  model?: string;
  name: string;
}

export interface ProposalRecord {
  agentId: string;
  field: ProposalField;
  requestId: string;
  status: "pending";
}

type RunPrincipal = Extract<Principal, { kind: "run" }>;

export interface LeadServiceDeps {
  agents: Pick<AgentsService, "update">;
  db: Database;
  events: Pick<EventsService, "onAppend">;
  inbox: Pick<InboxService, "createThread" | "post" | "startDiscussion">;
  requests: Pick<RequestsService, "open">;
}

/** What the member agent's setting is now, for the lead to read before it proposes. */
const memberOfAgent = (
  row: AgentRecord,
  leadAgentId: string | null
): LeadMember => ({
  ...(row.runtimeConfig.contextBudget === undefined
    ? {}
    : { contextBudget: row.runtimeConfig.contextBudget }),
  ...(row.runtimeConfig.effort === undefined
    ? {}
    : { effort: row.runtimeConfig.effort }),
  handle: row.slug,
  id: row.id,
  instructions: row.instructions,
  isLead: row.id === leadAgentId,
  kind: "agent",
  model: row.model,
  name: row.name,
});

const jsonBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

export const createLeadService = ({
  agents: agentsService,
  db,
  events,
  inbox,
  requests,
}: LeadServiceDeps) => {
  /** The run and the team room, or a refusal: only a lead in a run its team room woke may act. */
  const requireLead = async (
    principal: Principal
  ): Promise<{ room: LeadRoom; run: RunPrincipal }> => {
    if (principal.kind !== "run") {
      throw new ForbiddenError(LEAD_ACTION);
    }
    authorize(principal, LEAD_ACTION, {
      kind: TEAM_KIND,
      workspaceId: principal.workspaceId,
    });
    const run = await loadRun(db, principal.runId, principal.workspaceId);
    const room = run
      ? await leadRoomOf(db, {
          agentId: principal.agentId,
          sessionId: run.sessionId,
          workspaceId: principal.workspaceId,
        })
      : null;
    if (!room) {
      throw new ForbiddenError(LEAD_ACTION);
    }
    return { room, run: principal };
  };

  /** The room the run's agent leads, or null. The MCP route asks this to build the run's tool list. */
  const roomRun = async (principal: Principal): Promise<LeadRoom | null> => {
    try {
      return (await requireLead(principal)).room;
    } catch (error) {
      if (error instanceof ForbiddenError) {
        return null;
      }
      throw error;
    }
  };

  const members = async (principal: Principal): Promise<LeadMember[]> => {
    const { room, run } = await requireLead(principal);
    const rows = await db
      .select()
      .from(teamMembers)
      .where(eq(teamMembers.teamId, room.teamId))
      .orderBy(asc(teamMembers.memberKind), asc(teamMembers.memberId));
    const found: LeadMember[] = [];
    for (const row of rows) {
      if (row.memberKind === "agent") {
        // biome-ignore lint/performance/noAwaitInLoops: a team has a handful of members
        const agent = await findAgent(db, {
          id: row.memberId,
          workspaceId: row.workspaceId,
        });
        if (agent && agent.status === "active") {
          found.push(memberOfAgent(agent, run.agentId));
        }
        continue;
      }
      const [profile] = await db
        .select()
        .from(memberProfiles)
        .where(
          and(
            eq(memberProfiles.workspaceId, row.workspaceId),
            eq(memberProfiles.userId, row.memberId)
          )
        );
      found.push({
        ...(profile ? { handle: profile.handle } : {}),
        id: row.memberId,
        isLead: false,
        kind: "user",
        name: profile?.name ?? row.memberId,
      });
    }
    return found;
  };

  /** A topic of the lead's own team, or not found. */
  const requireTopic = async (
    run: RunPrincipal,
    room: LeadRoom,
    topic: string
  ) => {
    const [thread] = await db
      .select({ id: inboxThreads.id, teamId: inboxThreads.teamId })
      .from(inboxThreads)
      .where(
        and(
          eq(inboxThreads.id, topic),
          eq(inboxThreads.workspaceId, run.workspaceId)
        )
      )
      .limit(1);
    if (!thread || thread.teamId !== room.teamId) {
      throw new ServiceError("not_found", "Topic not found in this team");
    }
  };

  const post = async (
    principal: Principal,
    raw: PostTopicInput
  ): Promise<PostResult> => {
    const input = postTopicInputSchema.parse(raw);
    const { room, run } = await requireLead(principal);
    await requireTopic(run, room, input.topic);
    return await inbox.post(run, { text: input.text, threadId: input.topic });
  };

  const openTopic = async (
    principal: Principal,
    raw: OpenTopicInput
  ): Promise<ThreadRecord> => {
    const input = openTopicInputSchema.parse(raw);
    const { room, run } = await requireLead(principal);
    return await inbox.createThread(run, {
      ...(input.members === undefined ? {} : { members: input.members }),
      teamId: room.teamId,
      title: input.title,
    });
  };

  /** The member agent a proposal names: an active agent in the lead's team. */
  const memberAgent = async (
    run: RunPrincipal,
    room: LeadRoom,
    agentId: string
  ): Promise<AgentRecord> => {
    const [row] = await db
      .select({ memberId: teamMembers.memberId })
      .from(teamMembers)
      .where(
        and(
          eq(teamMembers.teamId, room.teamId),
          eq(teamMembers.memberKind, "agent"),
          eq(teamMembers.memberId, agentId)
        )
      );
    const agent = row
      ? await findAgent(db, { id: agentId, workspaceId: run.workspaceId })
      : null;
    if (agent?.status !== "active") {
      throw new ServiceError("not_found", "No member agent with that id");
    }
    return agent;
  };

  const checkedValue = (
    agent: AgentRecord,
    field: ProposalField,
    text: string
  ) => {
    const parsed = proposalValueSchemas[field].safeParse(text);
    if (!parsed.success) {
      throw new ServiceError(
        "invalid",
        `Not a valid ${field}: ${parsed.error.issues[0]?.message ?? "invalid value"}`
      );
    }
    if (field === "model") {
      assertModelForRuntime(agent.runtime, parsed.data);
    }
    return parsed.data;
  };

  const proposeChange = async (
    principal: Principal,
    raw: z.input<typeof proposeInputSchema>
  ): Promise<ProposalRecord> => {
    // The strict schema is the forbidden-field check: access, keys, ask-before
    // rules and connectors are not fields, so they never parse.
    const input = proposeInputSchema.parse(raw);
    const { room, run } = await requireLead(principal);
    const agent = await memberAgent(run, room, input.agentId);
    const value = checkedValue(agent, input.field, input.value);
    // The card sits in this topic's session, and a limited topic's session is
    // hidden from anyone who is not in it. An owner outside it could never answer.
    const ownerSeesTopic = await canReadTopic(
      db,
      { id: room.threadId, teamId: room.teamId },
      { id: effectiveOwner(agent), kind: "user" }
    );
    if (!ownerSeesTopic) {
      throw new ServiceError(
        "invalid",
        "The member's owner is not in this limited topic and could not see the proposal. Propose from a topic they are in."
      );
    }
    const lead = await findAgent(db, {
      id: run.agentId,
      workspaceId: run.workspaceId,
    });
    const stored: ProposalInput = {
      agentId: agent.id,
      agentName: agent.name,
      field: input.field,
      leadName: lead ? lead.name : run.agentId,
      reason: input.reason,
      value,
    };
    if (jsonBytes(stored) > PROPOSAL_INPUT_MAX_BYTES) {
      throw new ServiceError(
        "invalid",
        "The proposal is too long for an approval card. Shorten the value or the reason."
      );
    }
    // The card shows a scrubbed copy and the owner approves what it shows, so a
    // value the scrub would change (a token shape) is refused, not applied cut.
    if (JSON.stringify(redactToolPayload(stored)) !== JSON.stringify(stored)) {
      throw new ServiceError(
        "invalid",
        "The proposal holds text that looks like a secret. Remove it."
      );
    }
    const request = await requests.open(
      SYSTEM_PRINCIPAL,
      {
        input: stored,
        kind: "approval",
        runId: run.runId,
        toolKey: TEAM_PROPOSE_TOOL,
        toolName: TEAM_PROPOSE_TOOL,
        toolUseId: `${TEAM_PROPOSAL_PREFIX}${ulid()}`,
      },
      // Asked of the member's owner, who may answer after the lead's run ended.
      { agentId: agent.id, ttlMs: SKILL_CHANGE_TTL_MS }
    );
    return {
      agentId: agent.id,
      field: input.field,
      requestId: request.id,
      status: "pending",
    };
  };

  /** What an approved proposal changes: the instructions and the model are fields, the effort and the context budget are keys of the runtime config. */
  const applyProposal = async (
    approver: { userId: string; workspaceId: string },
    proposal: ProposalInput
  ) => {
    const principal: Principal = {
      kind: "user",
      userId: approver.userId,
      via: "session",
      workspaceId: approver.workspaceId,
    };
    if (proposal.field === "effort" || proposal.field === "contextBudget") {
      await agentsService.update(
        principal,
        proposal.agentId,
        {},
        { runtimeConfigPatch: { [proposal.field]: proposal.value } }
      );
      return;
    }
    await agentsService.update(principal, proposal.agentId, {
      [proposal.field]: proposal.value,
    });
  };

  // The member's owner (or an admin) answered the card: `requests.answer` has
  // checked who they are and refused Always allow. Only Allow once applies the
  // change; a denial, an expiry and a cancel leave the agent as it was. A
  // change that no longer applies (the agent was archived, the model left the
  // runtime) is logged, and never fails the owner's answer.
  events.onAppend(async (event) => {
    const { requestId } = event.payload;
    if (event.type !== "request.answered" || typeof requestId !== "string") {
      return;
    }
    const [row] = await db
      .select()
      .from(runRequests)
      .where(
        and(
          eq(runRequests.id, requestId),
          eq(runRequests.workspaceId, event.workspaceId)
        )
      );
    if (!(row && isTeamProposal(row) && row.answeredBy && row.answer)) {
      return;
    }
    const answer: unknown = JSON.parse(row.answer);
    const proposal = proposalOf(JSON.parse(row.display));
    const allowed =
      typeof answer === "object" &&
      answer !== null &&
      "decision" in answer &&
      answer.decision === "allow_once";
    if (!(allowed && proposal)) {
      return;
    }
    try {
      await applyProposal(
        { userId: row.answeredBy, workspaceId: row.workspaceId },
        proposal
      );
    } catch (error) {
      if (error instanceof ServiceError) {
        console.error("A team proposal no longer applies", requestId, error);
        return;
      }
      throw error;
    }
  });

  return {
    discussion: inbox.startDiscussion,
    members,
    openTopic,
    post,
    proposeChange,
    roomRun,
  };
};

export type LeadService = ReturnType<typeof createLeadService>;
