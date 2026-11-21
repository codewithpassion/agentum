import {
  type AgentAvatar,
  EVERYONE_TEAM_SLUG,
  type Team,
} from "@repo/db/shared";
import type { InboxPost, InboxThread } from "#/integrations/trpc/types.ts";
import { mentionedMembers } from "./mention-logic.ts";
import {
  memberKey,
  type RoomDirectory,
  type RoomMember,
} from "./room-types.ts";

export interface RoomAgentInput {
  avatar: AgentAvatar;
  id: string;
  name: string;
  slug: string;
}

export interface RoomPersonInput {
  name: string;
  userId: string;
}

const UNKNOWN_TEAMMATE_NAME = "Teammate";
const UNKNOWN_AGENT_NAME = "Agent";
const SLACK_GUEST_PREFIX = "slack:";
const SLACK_GUEST_POST = /^(.+?) \(Slack guest\): ([\s\S]*)$/;
const KIND_ORDER: Readonly<Record<RoomMember["kind"], number>> = {
  agent: 0,
  user: 1,
};

export const isEveryone = (team: Pick<Team, "slug">): boolean =>
  team.slug === EVERYONE_TEAM_SLUG;

/**
 * The team room an old inbox link lands in: the topic's own team, or the
 * Everyone team for a topic from before teams and for a link with no topic.
 * Null only when the workspace has no Everyone team.
 */
export const roomForInboxLink = (
  teams: readonly Pick<Team, "id" | "slug">[],
  threadTeamId: string | null
): string | null =>
  threadTeamId ?? teams.find((team) => isEveryone(team))?.id ?? null;

export const topicsOfTeam = (
  threads: readonly InboxThread[],
  team: Pick<Team, "id" | "slug">
): InboxThread[] => {
  const everyone = isEveryone(team);
  return threads.filter(
    (thread) =>
      thread.teamId === team.id || (everyone && thread.teamId === null)
  );
};

/** True when the person is in the team. An archived team keeps its members. */
export const isRoomMember = (
  team: Pick<Team, "members" | "slug">,
  userId: string
): boolean => {
  if (isEveryone(team)) {
    return true;
  }
  return team.members.some(
    (row) => row.memberKind === "user" && row.memberId === userId
  );
};

/** An archived team's room is read-only, whoever is in it. */
export const canPostInRoom = (
  team: Pick<Team, "archivedAt" | "members" | "slug">,
  userId: string
): boolean => team.archivedAt === null && isRoomMember(team, userId);

export const roomDirectory = (input: {
  agents: readonly RoomAgentInput[];
  handles: ReadonlyMap<string, string>;
  people: readonly RoomPersonInput[];
}): RoomDirectory => {
  const directory = new Map<string, RoomMember>();
  for (const agent of input.agents) {
    directory.set(memberKey("agent", agent.id), {
      avatar: agent.avatar,
      handle: agent.slug,
      id: agent.id,
      kind: "agent",
      name: agent.name,
    });
  }
  for (const person of input.people) {
    directory.set(memberKey("user", person.userId), {
      avatar: null,
      handle: input.handles.get(person.userId) ?? null,
      id: person.userId,
      kind: "user",
      name: person.name,
    });
  }
  return directory;
};

const compareMembers = (a: RoomMember, b: RoomMember): number =>
  KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
  a.name.localeCompare(b.name) ||
  a.id.localeCompare(b.id);

export const roomMembers = (input: {
  directory: RoomDirectory;
  team: Pick<Team, "members" | "slug">;
}): RoomMember[] => {
  const { directory, team } = input;
  const members = new Map<string, RoomMember>();
  if (isEveryone(team)) {
    for (const [key, member] of directory) {
      members.set(key, member);
    }
  } else {
    for (const row of team.members) {
      const key = memberKey(row.memberKind, row.memberId);
      const known = directory.get(key);
      if (known) {
        members.set(key, known);
      } else if (row.memberKind === "user") {
        members.set(key, {
          avatar: null,
          handle: null,
          id: row.memberId,
          kind: "user",
          name: UNKNOWN_TEAMMATE_NAME,
        });
      }
    }
  }
  return [...members.values()].sort(compareMembers);
};

/** The name and message of a post from a Slack guest, or null for any other post. */
export const guestOfPost = (
  post: Pick<InboxPost, "authorId" | "authorKind" | "text">
): { name: string; text: string } | null => {
  if (
    post.authorKind !== "user" ||
    !post.authorId.startsWith(SLACK_GUEST_PREFIX)
  ) {
    return null;
  }
  const match = SLACK_GUEST_POST.exec(post.text);
  const name = match?.[1];
  const text = match?.[2];
  if (name === undefined || text === undefined) {
    return null;
  }
  return { name, text };
};

export const memberOfPost = (
  post: Pick<InboxPost, "authorId" | "authorKind" | "text">,
  directory: RoomDirectory
): RoomMember => {
  const known = directory.get(memberKey(post.authorKind, post.authorId));
  if (known) {
    return known;
  }
  const guest = guestOfPost(post);
  if (guest) {
    return {
      avatar: null,
      handle: null,
      id: post.authorId,
      kind: "user",
      name: guest.name,
    };
  }
  return {
    avatar: null,
    handle: null,
    id: post.authorId,
    kind: post.authorKind,
    name:
      post.authorKind === "agent" ? UNKNOWN_AGENT_NAME : UNKNOWN_TEAMMATE_NAME,
  };
};

export const authorName = (member: RoomMember, userId: string): string =>
  member.kind === "user" && member.id === userId ? "You" : member.name;

export const assignedTo = (
  post: Pick<InboxPost, "authorId" | "authorKind" | "text">,
  leadAgentId: string | null,
  members: readonly RoomMember[]
): RoomMember[] => {
  const fromLeadAgent =
    post.authorKind === "agent" && post.authorId === leadAgentId;
  if (!fromLeadAgent) {
    return [];
  }
  return mentionedMembers(post.text, members).filter(
    (member) => !(member.kind === "agent" && member.id === post.authorId)
  );
};

export const topicSessionIds = (
  sessions: readonly { externalKey: string | null; id: string }[],
  threadId: string
): Set<string> => {
  const ids = new Set<string>();
  for (const session of sessions) {
    if (session.externalKey === threadId) {
      ids.add(session.id);
    }
  }
  return ids;
};

export const requestsOfTopic = <T extends { sessionId: string }>(
  records: readonly T[],
  sessionIds: ReadonlySet<string>
): T[] => records.filter((record) => sessionIds.has(record.sessionId));

/** The members without this person. A topic always has its creator, and nobody needs to mention themselves. */
export const withoutPerson = (
  members: readonly RoomMember[],
  userId: string
): RoomMember[] =>
  members.filter((member) => !(member.kind === "user" && member.id === userId));
