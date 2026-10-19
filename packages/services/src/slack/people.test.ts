import { beforeEach, expect, test } from "bun:test";
import {
  identityLinks,
  workspaces as workspaceRows,
} from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { createSlackClient, type SlackFetch } from "./client.ts";
import { linkedPeople } from "./people.ts";

const TOKEN = "xoxb-test-token-123";
const WORKSPACE = "w1";
const OTHER_WORKSPACE = "w2";
const TEAM = "T1";
const OTHER_TEAM = "T2";
const START = "2026-10-16T10:00:00.000Z";

const USERS: Record<string, unknown> = {
  U1: {
    ok: true,
    user: {
      name: "ann",
      profile: { display_name: "Ann", real_name: "Ann Lee" },
      real_name: "Ann L.",
    },
  },
  U5: { ok: true, user: { profile: {} } },
};

/** Answers users.info from USERS. Any other user is an error, as Slack answers for an unknown id. */
const fetch: SlackFetch = (url) => {
  const user = new URL(url).searchParams.get("user") ?? "";
  const body = USERS[user] ?? { error: "user_not_found", ok: false };
  return Promise.resolve(Response.json(body));
};

const client = createSlackClient({ fetch, token: TOKEN });

let db: ReturnType<typeof migrated>;

beforeEach(() => {
  db = migrated();
  for (const id of [WORKSPACE, OTHER_WORKSPACE]) {
    db.insert(workspaceRows)
      .values({
        clerkOrgId: `org_${id}`,
        createdAt: START,
        id,
        name: id,
        timezone: "UTC",
      })
      .run();
  }
  const links = [
    { externalUserId: "U1", teamId: TEAM, workspaceId: WORKSPACE },
    { externalUserId: "U2", teamId: TEAM, workspaceId: WORKSPACE },
    { externalUserId: "U5", teamId: TEAM, workspaceId: WORKSPACE },
    { externalUserId: "U3", teamId: OTHER_TEAM, workspaceId: WORKSPACE },
    { externalUserId: "U4", teamId: TEAM, workspaceId: OTHER_WORKSPACE },
  ];
  for (const [index, link] of links.entries()) {
    db.insert(identityLinks)
      .values({
        clerkUserId: `user_${index}`,
        createdAt: START,
        email: `${link.externalUserId.toLowerCase()}@example.test`,
        externalUserId: link.externalUserId,
        id: `il${index}`,
        provider: "slack",
        teamId: link.teamId,
        workspaceId: link.workspaceId,
      })
      .run();
  }
});

const byUser = <T extends { externalUserId: string }>(rows: T[]) =>
  [...rows].sort((a, b) => a.externalUserId.localeCompare(b.externalUserId));

test("linkedPeople returns Slack names and aliases of the team's linked people", async () => {
  const people = await linkedPeople(db, client, {
    teamId: TEAM,
    workspaceId: WORKSPACE,
  });

  expect(byUser(people)).toEqual([
    {
      aliases: ["Ann", "Ann Lee", "Ann L.", "ann"],
      email: "u1@example.test",
      externalUserId: "U1",
      slackName: "Ann",
    },
    {
      aliases: [],
      email: "u2@example.test",
      externalUserId: "U2",
      slackName: "u2@example.test",
    },
    {
      aliases: [],
      email: "u5@example.test",
      externalUserId: "U5",
      slackName: "u5@example.test",
    },
  ]);
});

test("linkedPeople falls back to the email with no aliases when users.info fails", async () => {
  const people = await linkedPeople(db, client, {
    teamId: TEAM,
    workspaceId: WORKSPACE,
  });

  expect(people.find((p) => p.externalUserId === "U2")).toEqual({
    aliases: [],
    email: "u2@example.test",
    externalUserId: "U2",
    slackName: "u2@example.test",
  });
});

test("linkedPeople leaves out links of another team or another workspace", async () => {
  const people = await linkedPeople(db, client, {
    teamId: TEAM,
    workspaceId: WORKSPACE,
  });
  const ids = people.map((p) => p.externalUserId);

  expect(ids).not.toContain("U3");
  expect(ids).not.toContain("U4");
});
