import { beforeEach, expect, test } from "bun:test";
import {
  inboxThreads as inboxThreadRows,
  inboxThreadMembers as threadMemberRows,
} from "@repo/db/schema/inbox";
import {
  teamMembers as teamMemberRows,
  teams as teamRows,
} from "@repo/db/schema/teams";
import { workspaces as workspaceRows } from "@repo/db/schema/workspaces";
import { EVERYONE_TEAM_SLUG, type TeamMemberKind } from "@repo/db/shared";
import { migrated } from "@repo/db/test-db";
import {
  canPostInTopic,
  canReadTopic,
  type Roomer,
  type RoomThread,
  topicVisibleTo,
} from "./room-access.ts";

const WORKSPACE = "w1";
const START = "2026-10-16T10:00:00.000Z";

const person = (id: string): Roomer => ({ id, kind: "user" });
const agent = (id: string): Roomer => ({ id, kind: "agent" });

let db: ReturnType<typeof migrated>;

const threadRow = (id: string, teamId: string | null) => ({
  createdAt: START,
  createdBy: "u1",
  id,
  lastPostAt: START,
  teamId,
  title: id,
  workspaceId: WORKSPACE,
});

const membership = (
  threadId: string,
  memberKind: TeamMemberKind,
  memberId: string
) => ({ memberId, memberKind, threadId, workspaceId: WORKSPACE });

const threadOf = (id: string): RoomThread => {
  const row = db
    .select()
    .from(inboxThreadRows)
    .all()
    .find((candidate) => candidate.id === id);
  if (!row) {
    throw new Error(`No thread ${id}`);
  }
  return { id: row.id, teamId: row.teamId };
};

const readable = (roomer: Roomer, id: string) =>
  canReadTopic(db, threadOf(id), roomer);
const postable = (roomer: Roomer, id: string) =>
  canPostInTopic(db, threadOf(id), roomer);

const visibleIds = (roomer: Roomer): string[] =>
  db
    .select()
    .from(inboxThreadRows)
    .where(topicVisibleTo(roomer))
    .all()
    .map((row) => row.id)
    .sort();

beforeEach(() => {
  db = migrated();
  db.insert(workspaceRows)
    .values({
      clerkOrgId: `org_${WORKSPACE}`,
      createdAt: START,
      id: WORKSPACE,
      name: WORKSPACE,
      timezone: "UTC",
    })
    .run();
  db.insert(teamRows)
    .values([
      {
        createdAt: START,
        id: "team-everyone",
        name: "Everyone",
        slug: EVERYONE_TEAM_SLUG,
        workspaceId: WORKSPACE,
      },
      {
        createdAt: START,
        id: "team-design",
        name: "Design",
        slug: "design",
        workspaceId: WORKSPACE,
      },
    ])
    .run();
  db.insert(teamMemberRows)
    .values([
      {
        memberId: "u1",
        memberKind: "user",
        teamId: "team-design",
        workspaceId: WORKSPACE,
      },
      {
        memberId: "bot",
        memberKind: "agent",
        teamId: "team-design",
        workspaceId: WORKSPACE,
      },
    ])
    .run();
});

test("a topic with no team is readable and postable by anyone", async () => {
  db.insert(inboxThreadRows).values(threadRow("open", null)).run();

  expect(await readable(person("u9"), "open")).toBe(true);
  expect(await postable(person("u9"), "open")).toBe(true);
  expect(await postable(agent("bot-9"), "open")).toBe(true);
});

test("the Everyone team lets any user and any agent post", async () => {
  db.insert(inboxThreadRows)
    .values(threadRow("everyone", "team-everyone"))
    .run();

  expect(await postable(person("u9"), "everyone")).toBe(true);
  expect(await postable(agent("bot-9"), "everyone")).toBe(true);
});

test("a team room topic without members is read by anyone but posted to by members only", async () => {
  db.insert(inboxThreadRows).values(threadRow("room", "team-design")).run();

  expect(await readable(person("u9"), "room")).toBe(true);
  expect(await postable(person("u9"), "room")).toBe(false);
  expect(await postable(person("u1"), "room")).toBe(true);
  expect(await postable(agent("bot"), "room")).toBe(true);
});

test("a user and an agent with the same id string do not cross kinds", async () => {
  db.insert(inboxThreadRows).values(threadRow("room", "team-design")).run();
  db.insert(inboxThreadRows).values(threadRow("limited", "team-design")).run();
  db.insert(threadMemberRows)
    .values([
      membership("limited", "user", "u1"),
      membership("limited", "agent", "bot"),
    ])
    .run();

  expect(await postable(agent("u1"), "room")).toBe(false);
  expect(await postable(person("bot"), "room")).toBe(false);
  expect(await readable(agent("u1"), "limited")).toBe(false);
  expect(await readable(person("bot"), "limited")).toBe(false);
});

test("a limited topic admits only its listed members", async () => {
  db.insert(inboxThreadRows).values(threadRow("limited", "team-design")).run();
  db.insert(threadMemberRows)
    .values([
      membership("limited", "user", "u1"),
      membership("limited", "agent", "bot"),
    ])
    .run();

  expect(await readable(person("u1"), "limited")).toBe(true);
  expect(await postable(person("u1"), "limited")).toBe(true);
  expect(await readable(agent("bot"), "limited")).toBe(true);
  expect(await postable(agent("bot"), "limited")).toBe(true);

  expect(await readable(person("u9"), "limited")).toBe(false);
  expect(await postable(person("u9"), "limited")).toBe(false);
  expect(await readable(agent("bot-9"), "limited")).toBe(false);
  expect(await postable(agent("bot-9"), "limited")).toBe(false);
});

test("a listed member who is not in the team reads but cannot post", async () => {
  db.insert(inboxThreadRows).values(threadRow("outside", "team-design")).run();
  db.insert(threadMemberRows)
    .values([membership("outside", "user", "u2")])
    .run();

  expect(await readable(person("u2"), "outside")).toBe(true);
  expect(await postable(person("u2"), "outside")).toBe(false);
});

test("a topic whose team row is missing cannot be posted to", async () => {
  // The team foreign key would refuse this row, so it is written with the check off.
  db.client.run("PRAGMA foreign_keys = OFF");
  db.insert(inboxThreadRows).values(threadRow("ghost", "team-missing")).run();
  db.client.run("PRAGMA foreign_keys = ON");

  expect(await readable(person("u1"), "ghost")).toBe(true);
  expect(await postable(person("u1"), "ghost")).toBe(false);
});

test("topicVisibleTo selects exactly the topics canReadTopic allows", async () => {
  db.insert(inboxThreadRows)
    .values([
      threadRow("open", null),
      threadRow("everyone", "team-everyone"),
      threadRow("room", "team-design"),
      threadRow("limited", "team-design"),
      threadRow("outside", "team-design"),
    ])
    .run();
  db.insert(threadMemberRows)
    .values([
      membership("limited", "user", "u1"),
      membership("limited", "agent", "bot"),
      membership("outside", "user", "u2"),
    ])
    .run();

  expect(visibleIds(person("u9"))).toEqual(["everyone", "open", "room"]);
  expect(visibleIds(person("u1"))).toEqual([
    "everyone",
    "limited",
    "open",
    "room",
  ]);
  expect(visibleIds(agent("bot"))).toEqual([
    "everyone",
    "limited",
    "open",
    "room",
  ]);

  const threads = db.select().from(inboxThreadRows).all();
  const roomers = [person("u1"), agent("bot"), agent("u1"), person("u2")];
  const expectations = await Promise.all(
    roomers.map(async (roomer) => {
      const allowed = await Promise.all(
        threads.map(async (row) =>
          (await canReadTopic(db, threadOf(row.id), roomer)) ? row.id : null
        )
      );
      return allowed.filter((id): id is string => id !== null).sort();
    })
  );
  for (const [index, roomer] of roomers.entries()) {
    expect(visibleIds(roomer)).toEqual(expectations[index] ?? []);
  }
});
