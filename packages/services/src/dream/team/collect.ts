// What a team dream reads: the shared notes of the members that share with the
// team, and the room's posts since the last team dream. A member's private
// files are never asked for (`loadMemory` with no `userScope`), and a topic
// limited to some members is never read, because the digest and the diary go
// to the whole team.
import type { Database } from "@repo/db";
import { agents } from "@repo/db/schema/agents";
import {
  inboxPosts,
  inboxThreadMembers,
  inboxThreads,
} from "@repo/db/schema/inbox";
import { memberProfiles } from "@repo/db/schema/teams";
import type { MemoryNote } from "@repo/db/shared";
import { and, asc, desc, eq, gt, inArray, notExists } from "drizzle-orm";
import { memoryFolderOf } from "../../library/memory-paths.ts";
import {
  type LoadedMemory,
  loadMemory,
  type MemoryLibrary,
} from "../../memory/files.ts";
import type { Principal } from "../../workspaces.ts";
import type { TeamInfo, TeamMember } from "./team.ts";

/** The topic the team diary and the lead's hand-off requests are posted in. The dream never reads it back. */
export const TEAM_DIARY_TOPIC = "Team diary";
const SYSTEM_AUTHOR = "system";
const POST_LIMIT = 200;
/** The most room text one dream sends the model. The newest posts win. */
export const POSTS_MAX_CHARS = 40_000;
const POST_CHARS = 1500;
/** The most note text one dream sends the model. The newest notes win. */
export const NOTES_MAX_CHARS = 60_000;

/** One shared note, and the member that holds it. */
export interface HeldNote {
  agentId: string;
  agentName: string;
  note: MemoryNote;
}

/** One member's loaded files, kept so the dream can write back what it read, guarded by the etags. */
export interface MemberMemory {
  loaded: LoadedMemory;
  member: TeamMember;
}

export interface RoomPost {
  author: string;
  authorKind: "agent" | "user";
  createdAt: string;
  id: string;
  text: string;
}

/** The shared files of each member, read as the team's principal. No private file is asked for. */
export const collectMemberMemory = async (
  library: MemoryLibrary,
  principal: Principal,
  members: readonly TeamMember[]
): Promise<MemberMemory[]> =>
  await Promise.all(
    members.map(async (member) => ({
      loaded: await loadMemory(library, principal, member.slug, null),
      member,
    }))
  );

/**
 * Whether anyone but this principal wrote a member's note file after `since`.
 * A note's date has no time of day, so the library's versions say it. The
 * dream's own writes do not count, or it would wake itself.
 */
export const membersChangedSince = async (
  library: Pick<MemoryLibrary, "versions">,
  principal: Extract<Principal, { kind: "user" }>,
  memories: readonly MemberMemory[],
  since: string
): Promise<boolean> => {
  for (const { loaded, member } of memories) {
    for (const path of Object.keys(loaded.files)) {
      // biome-ignore lint/performance/noAwaitInLoops: stops at the first change
      const [latest] = await library.versions(
        principal,
        `${memoryFolderOf(member.slug)}/${path}`
      );
      if (
        latest &&
        latest.createdAt > since &&
        latest.authorId !== principal.userId
      ) {
        return true;
      }
    }
  }
  return false;
};

/** The shared notes of all members, newest first within the character budget. */
export const heldNotesOf = (memories: readonly MemberMemory[]): HeldNote[] => {
  const all = memories.flatMap(({ loaded, member }) =>
    loaded.notes
      .filter((note) => note.userScope === null)
      .map((note) => ({ agentId: member.id, agentName: member.name, note }))
  );
  all.sort(
    (a, b) =>
      b.note.date.localeCompare(a.note.date) ||
      a.note.id.localeCompare(b.note.id)
  );
  const kept: HeldNote[] = [];
  let used = 0;
  for (const held of all) {
    if (used + held.note.text.length > NOTES_MAX_CHARS) {
      continue;
    }
    used += held.note.text.length;
    kept.push(held);
  }
  return kept;
};

/**
 * The room's posts since `since` (all of them, newest 200, for a first dream),
 * oldest first, from topics open to the whole team. The team's own diary topic
 * and posts by the system are left out, so a dream does not read itself.
 */
export const collectRoomPosts = async (
  db: Database,
  team: Pick<TeamInfo, "id" | "workspaceId">,
  since: string | null
): Promise<RoomPost[]> => {
  const rows = await db
    .select({
      authorId: inboxPosts.authorId,
      authorKind: inboxPosts.authorKind,
      createdAt: inboxPosts.createdAt,
      guestName: inboxPosts.guestName,
      id: inboxPosts.id,
      text: inboxPosts.text,
    })
    .from(inboxPosts)
    .innerJoin(inboxThreads, eq(inboxThreads.id, inboxPosts.threadId))
    .where(
      and(
        eq(inboxThreads.teamId, team.id),
        eq(inboxThreads.workspaceId, team.workspaceId),
        eq(inboxPosts.workspaceId, team.workspaceId),
        since === null ? undefined : gt(inboxPosts.createdAt, since),
        notExists(
          db
            .select({ one: inboxThreadMembers.threadId })
            .from(inboxThreadMembers)
            .where(eq(inboxThreadMembers.threadId, inboxThreads.id))
        )
      )
    )
    .orderBy(desc(inboxPosts.id))
    .limit(POST_LIMIT + 50);
  const readable = rows.filter((row) => row.authorId !== SYSTEM_AUTHOR);
  const titles = await db
    .select({ id: inboxThreads.id })
    .from(inboxThreads)
    .where(
      and(
        eq(inboxThreads.teamId, team.id),
        eq(inboxThreads.workspaceId, team.workspaceId),
        eq(inboxThreads.title, TEAM_DIARY_TOPIC)
      )
    );
  const diaryThreads = new Set(titles.map((row) => row.id));
  // The diary topic's posts are the dream's own words, left out by thread.
  const ids = readable.map((row) => row.id);
  const inDiary =
    ids.length === 0 || diaryThreads.size === 0
      ? new Set<string>()
      : new Set(
          (
            await db
              .select({ id: inboxPosts.id })
              .from(inboxPosts)
              .where(
                and(
                  inArray(inboxPosts.id, ids),
                  inArray(inboxPosts.threadId, [...diaryThreads])
                )
              )
          ).map((row) => row.id)
        );
  const kept = readable
    .filter((row) => !inDiary.has(row.id))
    .slice(0, POST_LIMIT);
  const names = await namesOf(db, team.workspaceId, kept);
  const posts: RoomPost[] = [];
  let used = 0;
  for (const row of kept) {
    const text = row.text.slice(0, POST_CHARS);
    if (used + text.length > POSTS_MAX_CHARS) {
      break;
    }
    used += text.length;
    posts.push({
      author:
        row.guestName === null
          ? (names.get(`${row.authorKind}:${row.authorId}`) ?? "A person")
          : `${row.guestName} (Slack guest)`,
      authorKind: row.authorKind,
      createdAt: row.createdAt,
      id: row.id,
      text,
    });
  }
  return posts.reverse();
};

const namesOf = async (
  db: Database,
  workspaceId: string,
  rows: readonly { authorId: string; authorKind: "agent" | "user" }[]
): Promise<Map<string, string>> => {
  const agentIds = [
    ...new Set(
      rows.flatMap((row) => (row.authorKind === "agent" ? [row.authorId] : []))
    ),
  ];
  const userIds = [
    ...new Set(
      rows.flatMap((row) => (row.authorKind === "user" ? [row.authorId] : []))
    ),
  ];
  const names = new Map<string, string>();
  if (agentIds.length > 0) {
    const found = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(
        and(eq(agents.workspaceId, workspaceId), inArray(agents.id, agentIds))
      )
      .orderBy(asc(agents.id));
    for (const row of found) {
      names.set(`agent:${row.id}`, row.name);
    }
  }
  if (userIds.length > 0) {
    const found = await db
      .select({ name: memberProfiles.name, userId: memberProfiles.userId })
      .from(memberProfiles)
      .where(
        and(
          eq(memberProfiles.workspaceId, workspaceId),
          inArray(memberProfiles.userId, userIds)
        )
      );
    for (const row of found) {
      names.set(`user:${row.userId}`, row.name);
    }
  }
  return names;
};
