import { expect, test } from "bun:test";
import { slackApps } from "@repo/db/schema/slack";
import { workspaces as workspaceRows } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { createAgentsService } from "../agents.ts";
import { createEventsService } from "../events.ts";
import type { Principal } from "../workspaces.ts";
import {
  SLACK_ALL_MESSAGES_GUIDANCE,
  SLACK_GUIDANCE,
  slackGuidanceFor,
} from "./guidance.ts";

const START = "2026-10-16T10:00:00.000Z";
const WORKSPACE = "w1";

const db = migrated();
const events = createEventsService({
  blobs: { get: () => Promise.resolve(null), put: () => Promise.resolve() },
  db,
});
const agents = createAgentsService({ db, events });

const user: Principal = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: WORKSPACE,
};

db.insert(workspaceRows)
  .values({
    clerkOrgId: "org_w1",
    createdAt: START,
    id: WORKSPACE,
    name: WORKSPACE,
    timezone: "UTC",
  })
  .run();

const newAgent = async (name: string) =>
  (await agents.create(user, { model: "m", name, runtime: "fake" })).id;

const installApp = (
  agentId: string,
  fields: {
    appId: string;
    id: string;
    listenMode?: "all" | "mentions";
    status: "created" | "installed" | "revoked";
    teamId?: string;
  }
) =>
  db
    .insert(slackApps)
    .values({
      agentId,
      appId: fields.appId,
      botToken: null,
      botUserId: "U0BOT",
      createdAt: START,
      id: fields.id,
      listenMode: fields.listenMode ?? "mentions",
      signingSecret: "ciphertext",
      status: fields.status,
      teamId: fields.teamId ?? "T0TEAM",
      workspaceId: WORKSPACE,
    })
    .run();

test("returns the Slack line for an agent with an installed app", async () => {
  const agentId = await newAgent("Installed");
  installApp(agentId, {
    appId: "A0INSTALLED",
    id: "app-installed",
    status: "installed",
  });

  expect(await slackGuidanceFor(db, { agentId, workspaceId: WORKSPACE })).toBe(
    SLACK_GUIDANCE
  );
});

test("returns an empty string for an agent with no app", async () => {
  const agentId = await newAgent("Bare");

  expect(await slackGuidanceFor(db, { agentId, workspaceId: WORKSPACE })).toBe(
    ""
  );
});

test("returns an empty string for an app that is not installed", async () => {
  const agentId = await newAgent("Revoked");
  installApp(agentId, {
    appId: "A0REVOKED",
    id: "app-revoked",
    status: "revoked",
  });

  expect(await slackGuidanceFor(db, { agentId, workspaceId: WORKSPACE })).toBe(
    ""
  );
});

test("adds the all-messages line for an installed app in all mode", async () => {
  const agentId = await newAgent("AllMode");
  installApp(agentId, {
    appId: "A0ALL",
    id: "app-all",
    listenMode: "all",
    status: "installed",
  });

  const guidance = await slackGuidanceFor(db, {
    agentId,
    workspaceId: WORKSPACE,
  });
  expect(guidance).toBe(`${SLACK_GUIDANCE} ${SLACK_ALL_MESSAGES_GUIDANCE}`);
  expect(guidance.endsWith(` ${SLACK_ALL_MESSAGES_GUIDANCE}`)).toBe(true);
});

test("adds no all-messages line for an installed app in mentions mode", async () => {
  const agentId = await newAgent("MentionsMode");
  installApp(agentId, {
    appId: "A0MENTIONS",
    id: "app-mentions",
    listenMode: "mentions",
    status: "installed",
  });

  expect(await slackGuidanceFor(db, { agentId, workspaceId: WORKSPACE })).toBe(
    SLACK_GUIDANCE
  );
});

test("adds the all-messages line once when one of two installed apps is in all mode", async () => {
  const agentId = await newAgent("TwoApps");
  installApp(agentId, {
    appId: "A0TWOMENTIONS",
    id: "app-two-mentions",
    listenMode: "mentions",
    status: "installed",
  });
  installApp(agentId, {
    appId: "A0TWOALL",
    id: "app-two-all",
    listenMode: "all",
    status: "installed",
    teamId: "T0OTHERTEAM",
  });

  const guidance = await slackGuidanceFor(db, {
    agentId,
    workspaceId: WORKSPACE,
  });
  expect(guidance).toBe(`${SLACK_GUIDANCE} ${SLACK_ALL_MESSAGES_GUIDANCE}`);
  expect(guidance.split(SLACK_ALL_MESSAGES_GUIDANCE).length - 1).toBe(1);
});

test("returns an empty string for a revoked app in all mode", async () => {
  const agentId = await newAgent("RevokedAll");
  installApp(agentId, {
    appId: "A0REVOKEDALL",
    id: "app-revoked-all",
    listenMode: "all",
    status: "revoked",
  });

  expect(await slackGuidanceFor(db, { agentId, workspaceId: WORKSPACE })).toBe(
    ""
  );
});

test("returns an empty string when the installed app belongs to another agent", async () => {
  const owner = await newAgent("Owner");
  const other = await newAgent("Other");
  installApp(owner, { appId: "A0OWNER", id: "app-owner", status: "installed" });

  expect(
    await slackGuidanceFor(db, { agentId: other, workspaceId: WORKSPACE })
  ).toBe("");
});
