import { beforeEach, expect, test } from "bun:test";
import { agents as agentRows } from "@repo/db/schema/agents";
import { slackApps, teamSlackLinks } from "@repo/db/schema/slack";
import { teamMembers, teams } from "@repo/db/schema/teams";
import { workspaces as workspaceRows } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { encryptSecret, importSecretsKey } from "../crypto.ts";
import { slackSecretBinding } from "./apps.ts";
import type { SlackFetch } from "./client.ts";
import { createRoomStatus } from "./room-status.ts";

const WORKSPACE = "ws-1";
const TEAM = "team-1";
const SLACK_TEAM = "T-SLACK";
const CHANNEL = "C-ROOM";
const START = "2026-10-16T10:00:00.000Z";
const SECRETS_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

const IN_CHANNEL_TOKEN = "xoxb-in";
const OUT_OF_CHANNEL_TOKEN = "xoxb-out";
const GONE_TOKEN = "xoxb-gone";

/** What Slack says about the channel for each bot token. Other tokens are rejected. */
const membershipAnswers = new Map<string, Record<string, unknown>>([
  [
    IN_CHANNEL_TOKEN,
    { channel: { is_member: true, name: "crew-room" }, ok: true },
  ],
  [OUT_OF_CHANNEL_TOKEN, { channel: { is_member: false }, ok: true }],
  [GONE_TOKEN, { error: "channel_not_found", ok: false }],
]);

/** One conversations.info call the fake Slack received. */
interface Recorded {
  channel: string | null;
  token: string | null;
}

let db: ReturnType<typeof migrated>;
let key: CryptoKey;
let calls: Recorded[];

const slackFetch: SlackFetch = (url, init) => {
  const parsed = new URL(url);
  const token =
    new Headers(init.headers).get("Authorization")?.replace("Bearer ", "") ??
    null;
  calls.push({ channel: parsed.searchParams.get("channel"), token });
  const answer = membershipAnswers.get(token ?? "") ?? {
    error: "invalid_auth",
    ok: false,
  };
  return Promise.resolve(Response.json(answer));
};

const addAgent = (id: string, status = "active") => {
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
      status,
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

const addPerson = (userId: string) => {
  db.insert(teamMembers)
    .values({
      memberId: userId,
      memberKind: "user",
      teamId: TEAM,
      workspaceId: WORKSPACE,
    })
    .run();
};

/** Installs an app for `agentId` in a Slack team. A null token leaves the app without one. */
const installApp = async (
  agentId: string,
  token: string | null,
  slackTeamId = SLACK_TEAM
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
      createdAt: START,
      id,
      signingSecret: "ciphertext",
      status: "installed",
      teamId: slackTeamId,
      workspaceId: WORKSPACE,
    })
    .run();
};

const linkRoom = () => {
  db.insert(teamSlackLinks)
    .values({
      channelId: CHANNEL,
      createdAt: START,
      id: "link-1",
      linkedBy: "u1",
      slackTeamId: SLACK_TEAM,
      teamId: TEAM,
      workspaceId: WORKSPACE,
    })
    .run();
};

const statusWith = (secretsKey: string | undefined) =>
  createRoomStatus({ db, fetch: slackFetch, secretsKey })(WORKSPACE, TEAM);
const readStatus = () => statusWith(SECRETS_KEY);

beforeEach(async () => {
  db = migrated();
  key = await importSecretsKey(SECRETS_KEY);
  calls = [];
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

test("a team with no Slack link reads as unlinked, with no apps", async () => {
  addAgent("a-1");
  await installApp("a-1", IN_CHANNEL_TOKEN);

  expect(await readStatus()).toEqual({
    apps: [],
    channelName: null,
    link: null,
  });
  expect(calls).toEqual([]);
});

test("reports each agent member's app and whether its bot is in the linked channel", async () => {
  linkRoom();
  addAgent("a-in");
  addAgent("a-out");
  addAgent("a-noapp");
  await installApp("a-in", IN_CHANNEL_TOKEN);
  await installApp("a-out", OUT_OF_CHANNEL_TOKEN);

  expect(await readStatus()).toEqual({
    apps: [
      { agentId: "a-in", botUserId: "B-a-in", inChannel: true },
      { agentId: "a-noapp", botUserId: null, inChannel: false },
      { agentId: "a-out", botUserId: "B-a-out", inChannel: false },
    ],
    channelName: "crew-room",
    link: {
      channelId: CHANNEL,
      createdAt: START,
      linkedBy: "u1",
      slackTeamId: SLACK_TEAM,
      teamId: TEAM,
    },
  });
});

test("asks Slack about each app's own bot token and the linked channel", async () => {
  linkRoom();
  addAgent("a-in");
  addAgent("a-out");
  addAgent("a-noapp");
  await installApp("a-in", IN_CHANNEL_TOKEN);
  await installApp("a-out", OUT_OF_CHANNEL_TOKEN);

  await readStatus();

  expect(calls).toEqual(
    expect.arrayContaining([
      { channel: CHANNEL, token: IN_CHANNEL_TOKEN },
      { channel: CHANNEL, token: OUT_OF_CHANNEL_TOKEN },
    ])
  );
  expect(calls.every(({ channel }) => channel === CHANNEL)).toBe(true);
});

test("the channel name comes from a member app that can read it, and is null when none can", async () => {
  linkRoom();
  addAgent("a-gone");
  await installApp("a-gone", GONE_TOKEN);

  expect((await readStatus()).channelName).toBeNull();

  addAgent("a-in");
  await installApp("a-in", IN_CHANNEL_TOKEN);

  expect((await readStatus()).channelName).toBe("crew-room");
});

test("an app whose Slack answers channel_not_found is not in the channel", async () => {
  linkRoom();
  addAgent("a-gone");
  await installApp("a-gone", GONE_TOKEN);

  expect(await readStatus()).toMatchObject({
    apps: [{ agentId: "a-gone", botUserId: "B-a-gone", inChannel: false }],
  });
});

test("an app with no bot token is not in the channel, and Slack is not asked", async () => {
  linkRoom();
  addAgent("a-notoken");
  await installApp("a-notoken", null);

  expect(await readStatus()).toMatchObject({
    apps: [
      { agentId: "a-notoken", botUserId: "B-a-notoken", inChannel: false },
    ],
  });
  expect(calls).toEqual([]);
});

test("a bot token that cannot be decrypted is not in the channel, and the read does not throw", async () => {
  linkRoom();
  addAgent("a-broken");
  db.insert(slackApps)
    .values({
      agentId: "a-broken",
      appId: "A-broken",
      botToken: "not-a-secret",
      botUserId: "B-a-broken",
      createdAt: START,
      id: "app-broken",
      signingSecret: "ciphertext",
      status: "installed",
      teamId: SLACK_TEAM,
      workspaceId: WORKSPACE,
    })
    .run();

  expect(await readStatus()).toMatchObject({
    apps: [{ agentId: "a-broken", botUserId: "B-a-broken", inChannel: false }],
  });
  expect(calls).toEqual([]);
});

test("a token with no SECRETS_KEY configured is not in the channel, and the read does not throw", async () => {
  linkRoom();
  addAgent("a-in");
  await installApp("a-in", IN_CHANNEL_TOKEN);

  expect(await statusWith(undefined)).toMatchObject({
    apps: [{ agentId: "a-in", botUserId: "B-a-in", inChannel: false }],
  });
  expect(calls).toEqual([]);
});

test("archived agents and person members are left out", async () => {
  linkRoom();
  addAgent("a-live");
  addAgent("a-archived", "archived");
  addPerson("u-ann");
  await installApp("a-live", IN_CHANNEL_TOKEN);
  await installApp("a-archived", IN_CHANNEL_TOKEN);

  expect(await readStatus()).toMatchObject({
    apps: [{ agentId: "a-live", botUserId: "B-a-live", inChannel: true }],
  });
});

test("apps installed in another Slack workspace do not count", async () => {
  linkRoom();
  addAgent("a-other");
  await installApp("a-other", IN_CHANNEL_TOKEN, "T-OTHER");

  expect(await readStatus()).toMatchObject({
    apps: [{ agentId: "a-other", botUserId: null, inChannel: false }],
  });
  expect(calls).toEqual([]);
});
