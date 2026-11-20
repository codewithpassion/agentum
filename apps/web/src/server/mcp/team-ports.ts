// The `team` group of the platform MCP tools: a lead's team room, over the
// lead service, acting as the run. The service refuses every caller that is
// not a lead in its team room, and `guarded` turns that refusal into a
// `ToolError`. Records are copied field by field so no storage detail (the
// workspace id, the team id) reaches an agent.
import type {
  PostInfo,
  TeamMemberInfo,
  TeamPort,
  TeamProposalInfo,
  ThreadInfo,
} from "@repo/mcp/ports";
import type { PostRecord, ThreadRecord } from "@repo/services/inbox";
import type {
  LeadMember,
  LeadService,
  ProposalRecord,
} from "@repo/services/teams/lead";
import type { Principal } from "@repo/services/workspaces";
import { guarded } from "./guarded.ts";

const toMemberInfo = (member: LeadMember): TeamMemberInfo => ({
  id: member.id,
  isLead: member.isLead,
  kind: member.kind,
  name: member.name,
  ...(member.contextBudget === undefined
    ? {}
    : { contextBudget: member.contextBudget }),
  ...(member.effort === undefined ? {} : { effort: member.effort }),
  ...(member.handle === undefined ? {} : { handle: member.handle }),
  ...(member.instructions === undefined
    ? {}
    : { instructions: member.instructions }),
  ...(member.model === undefined ? {} : { model: member.model }),
});

const toThreadInfo = (thread: ThreadRecord): ThreadInfo => ({
  createdAt: thread.createdAt,
  id: thread.id,
  lastPostAt: thread.lastPostAt,
  title: thread.title,
});

const toPostInfo = (post: PostRecord): PostInfo => ({
  authorId: post.authorId,
  authorKind: post.authorKind,
  createdAt: post.createdAt,
  id: post.id,
  runId: post.runId,
  text: post.text,
});

const toProposalInfo = (proposal: ProposalRecord): TeamProposalInfo => ({
  agentId: proposal.agentId,
  field: proposal.field,
  requestId: proposal.requestId,
  status: proposal.status,
});

export const createTeamPorts = ({
  principal,
  services,
}: {
  principal: Principal;
  services: {
    teamLead: Pick<
      LeadService,
      "members" | "openTopic" | "post" | "proposeChange"
    >;
  };
}): TeamPort => {
  const { teamLead } = services;
  return {
    members: () =>
      guarded(async () =>
        (await teamLead.members(principal)).map(toMemberInfo)
      ),
    openTopic: (input) =>
      guarded(async () =>
        toThreadInfo(await teamLead.openTopic(principal, input))
      ),
    post: (input) =>
      guarded(async () => {
        const posted = await teamLead.post(principal, input);
        return { post: toPostInfo(posted.post), runs: posted.runs };
      }),
    proposeChange: (input) =>
      guarded(async () =>
        toProposalInfo(await teamLead.proposeChange(principal, input))
      ),
  };
};
