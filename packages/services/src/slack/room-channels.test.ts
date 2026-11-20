import { beforeEach, expect, test } from "bun:test";
import { agents as agentRows } from "@repo/db/schema/agents";
import { slackApps } from "@repo/db/schema/slack";
import { teamMembers, teams } from "@repo/db/schema/teams";
import { workspaces as workspaceRows } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { encryptSecret, importSecretsKey } from "../crypto.ts";
import { slackSecretBinding } from "./apps.ts";
import type { SlackFetch } from "./client.ts";
import { createRoomChannels, roomApps } from "./room-channels.ts";

const WORKSPACE = "ws-1";
const TEAM = "team-1";
const SLACK_TEAM = "T-ONE";
const OTHER_SLACK_TEAM = "T-TWO";
const START = "2026-10-16T10:00:00.000Z";
const SECRETS_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

/** What each bot token's app sees. Every other token is rejected. */
const LEAD_TOKEN = "xoxb-lead";
const MEMBER_TOKEN = "xoxb-member";
const BAD_TOKEN = "xoxb-bad";

interface Seen {
  method: string;
  token: string | null;
}

let db: ReturnType<typeof migrated>;
let key: CryptoKey;
let seen: Seen[];

const channelsByToken = new Map<string, unknown[]>([
  [
    LEAD_TOKEN,
    [
      { id: "C2", is_private: true, name: "zebra" },
      { id: "C1", is_private: false, name: "alpha" },
    ],
  ],
  [MEMBER_TOKEN, [{ id: "C3", is_private: false, name: "member-only" }]],
]);
const memberOf = new Map<string, Set<string>>([
  [LEAD_TOKEN, new Set(["C1", "C2"])],
  [MEMBER_TOKEN, new Set(["C3"])],
]);

const slackFetch: SlackFetch = (url, init) => {
  const parsed = new URL(url);
  const method = parsed.pathname.split("/").at(-1) ?? "";
  const token =
    new Headers(init.headers).get("Authorization")?.replace("Bearer ", "") ??
    null;
  seen.push({ method, token });
  const channels = channelsByToken.get(token ?? "");
  if (channels === undefined) {
    return Promise.resolve(Response.json({ error: "invalid_auth", ok: false }));
  }
  if (method === "users.conversations") {
    return Promise.resolve(Response.json({ channels, ok: true }));
  }
  const id = parsed.searchParams.get("channel") ?? "";
  const channel = channels.find(
    (entry) => (entry as { id: string }).id === id
  ) as { name: string } | undefined;
  return Promise.resolve(
    Response.json({
      channel: {
        is_member: memberOf.get(token ?? "")?.has(id) === true,
        name: channel?.name,
      },
      ok: true,
    })
  );
};

const addAgent = (id: string) => {
  db.insert(agentRows)
    .values({
      createdAt: START,
      createdBy: "u1",
      id,
      instructions: "",
      model: "m",
      name: id,
      runtime: "fake",
      runtimeConfig: "{}",
      slug: id,
      status: "active",
      workspaceId: WORKSPACE,
    })
    .run();
  db.insert(teamMembers)
    .values({
      memberId: id,
      memberKind: "agent",
      teamId: TEAM,
      workspaceId: WORKSPACE,
    })
    .run();
};

const installApp = async (
  agentId: string,
  token: string | null,
  { createdAt = START, slackTeamId = SLACK_TEAM } = {}
) => {
  const id = `app-${agentId}-${slackTeamId}`;
  const botToken =
    token === null
      ? null
      : await encryptSecret(
          key,
          slackSecretBinding({ id, workspaceId: WORKSPACE }, "bot_token"),
          token
        );
  db.insert(slackApps)
    .values({
      agentId,
      appId: `A-${id}`,
      botToken,
      botUserId: `B-${agentId}`,
      createdAt,
      id,
      signingSecret: "ciphertext",
      status: "installed",
      teamId: slackTeamId,
      workspaceId: WORKSPACE,
    })
    .run();
};

const channels = () =>
  createRoomChannels({ db, fetch: slackFetch, secretsKey: SECRETS_KEY });

beforeEach(async () => {
  db = migrated();
  key = await importSecretsKey(SECRETS_KEY);
  seen = [];
  db.insert(workspaceRows)
    .values({
      clerkOrgId: `org_${WORKSPACE}`,
      createdAt: START,
      id: WORKSPACE,
      name: WORKSPACE,
      timezone: "UTC",
    })
    .run();
  db.insert(teams)
    .values({
      createdAt: START,
      id: TEAM,
      name: "Crew",
      slug: "crew",
      workspaceId: WORKSPACE,
    })
    .run();
});

const setLead = (agentId: string) => {
  db.update(teams).set({ leadAgentId: agentId }).run();
};

test("list gives the lead app's channels by name, with the Slack workspace they are in", async () => {
  addAgent("a-member");
  addAgent("a-lead");
  await installApp("a-member", MEMBER_TOKEN);
  await installApp("a-lead", LEAD_TOKEN, { createdAt: "2026-10-17T10:00:00Z" });
  setLead("a-lead");

  expect(await channels().list(WORKSPACE, TEAM)).toEqual({
    channels: [
      { id: "C1", isPrivate: false, name: "alpha" },
      { id: "C2", isPrivate: true, name: "zebra" },
    ],
    slackTeamId: SLACK_TEAM,
  });
  expect(seen).toEqual([{ method: "users.conversations", token: LEAD_TOKEN }]);
});

test("without a lead the oldest member app answers", async () => {
  addAgent("a-new");
  addAgent("a-old");
  await installApp("a-new", LEAD_TOKEN, { createdAt: "2026-10-17T10:00:00Z" });
  await installApp("a-old", MEMBER_TOKEN);

  expect(await channels().list(WORKSPACE, TEAM)).toMatchObject({
    channels: [{ id: "C3", name: "member-only" }],
  });
});

test("a team whose agents have no Slack app has no channels and no Slack workspace", async () => {
  addAgent("a-1");

  expect(await channels().list(WORKSPACE, TEAM)).toEqual({
    channels: [],
    slackTeamId: null,
  });
  expect(seen).toEqual([]);
});

test("an app that cannot be read is skipped, and when every app fails the list is refused", async () => {
  addAgent("a-notoken");
  addAgent("a-bad");
  await installApp("a-notoken", null);
  await installApp("a-bad", BAD_TOKEN);

  await expect(channels().list(WORKSPACE, TEAM)).rejects.toMatchObject({
    code: "invalid",
    message: "Slack would not list the channels (invalid_auth).",
  });
  expect(seen.map(({ token }) => token)).toEqual([BAD_TOKEN]);
});

test("a failing lead app hands over to the next member app", async () => {
  addAgent("a-bad");
  addAgent("a-member");
  await installApp("a-bad", BAD_TOKEN);
  await installApp("a-member", MEMBER_TOKEN, {
    createdAt: "2026-10-17T10:00:00Z",
  });
  setLead("a-bad");

  expect(await channels().list(WORKSPACE, TEAM)).toMatchObject({
    channels: [{ id: "C3" }],
  });
});

test("an app of an archived agent is not asked", async () => {
  addAgent("a-1");
  addAgent("a-gone");
  db.update(agentRows)
    .set({ status: "archived" })
    .where(eq(agentRows.id, "a-gone"))
    .run();
  await installApp("a-gone", LEAD_TOKEN);
  await installApp("a-1", MEMBER_TOKEN);

  expect(
    (await roomApps(db, { teamId: TEAM, workspaceId: WORKSPACE })).map(
      (app) => app.agentId
    )
  ).toEqual(["a-1"]);
});

test("canPost is true only when a member app in that Slack workspace is in the channel", async () => {
  addAgent("a-lead");
  await installApp("a-lead", LEAD_TOKEN);
  setLead("a-lead");

  expect(await channels().canPost(WORKSPACE, TEAM, SLACK_TEAM, "C1")).toBe(
    true
  );
  expect(await channels().canPost(WORKSPACE, TEAM, SLACK_TEAM, "C9")).toBe(
    false
  );
  expect(
    await channels().canPost(WORKSPACE, TEAM, OTHER_SLACK_TEAM, "C1")
  ).toBe(false);
});

test("canPost is true when only a non-lead member app is in the channel", async () => {
  addAgent("a-lead");
  addAgent("a-member");
  await installApp("a-lead", LEAD_TOKEN);
  await installApp("a-member", MEMBER_TOKEN);
  setLead("a-lead");

  expect(await channels().canPost(WORKSPACE, TEAM, SLACK_TEAM, "C3")).toBe(
    true
  );
});

test("nameOf gives the channel's name from a member app, or null", async () => {
  addAgent("a-lead");
  await installApp("a-lead", LEAD_TOKEN);

  expect(await channels().nameOf(WORKSPACE, TEAM, SLACK_TEAM, "C2")).toBe(
    "zebra"
  );
  expect(await channels().nameOf(WORKSPACE, TEAM, SLACK_TEAM, "C9")).toBeNull();
});
