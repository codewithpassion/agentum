import { expect, test } from "bun:test";
import { slackApps } from "@repo/db/schema/slack";
import { workspaces as workspaceRows } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { createAgentsService } from "../agents.ts";
import { createEventsService } from "../events.ts";
import type { Principal } from "../workspaces.ts";
import { SLACK_GUIDANCE, slackGuidanceFor } from "./guidance.ts";

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
    status: "created" | "installed" | "revoked";
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
      signingSecret: "ciphertext",
      status: fields.status,
      teamId: "T0TEAM",
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

test("returns an empty string when the installed app belongs to another agent", async () => {
  const owner = await newAgent("Owner");
  const other = await newAgent("Other");
  installApp(owner, { appId: "A0OWNER", id: "app-owner", status: "installed" });

  expect(
    await slackGuidanceFor(db, { agentId: other, workspaceId: WORKSPACE })
  ).toBe("");
});
