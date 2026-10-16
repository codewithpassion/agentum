import { expect, test } from "bun:test";
import { migrated } from "@repo/db/test-db";
import { decryptSecret, importSecretsKey } from "@repo/services/crypto";
import { slackSecretBinding } from "@repo/services/slack/apps";
import { type SeedSlackAppInput, seedSlackApp } from "./seed-slack-app.ts";

const SECRETS_KEY = Buffer.from(new Uint8Array(32).fill(5)).toString("base64");
const WORKSPACE = "ws_dev";
const AGENT = "agent_fake";
const SECRET = "signing-secret-one";

type Db = ReturnType<typeof migrated>;

const setup = (): Db => {
  const db = migrated();
  db.client.run(
    "INSERT INTO workspaces (id, clerk_org_id, name, timezone, created_at) VALUES (?, ?, ?, ?, ?)",
    [WORKSPACE, "org_dev", "Dev Workspace", "UTC", "2026-01-01T00:00:00.000Z"]
  );
  db.client.run(
    "INSERT INTO agents (id, created_at, created_by, instructions, model, name, runtime, runtime_config, slug, status, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      AGENT,
      "2026-01-01T00:00:00.000Z",
      "user_dev",
      "Echoes whatever it is told.",
      "fake",
      "Fake echo",
      "fake",
      "{}",
      "fake-echo",
      "active",
      WORKSPACE,
    ]
  );
  return db;
};

const input = (
  db: Db,
  overrides: Partial<SeedSlackAppInput> = {}
): SeedSlackAppInput => ({
  agentId: AGENT,
  clerkUserId: "user_dev",
  db,
  secret: SECRET,
  secretsKey: SECRETS_KEY,
  workspaceId: WORKSPACE,
  ...overrides,
});

/** The only element of a list the test expects to have exactly one. */
const one = <T>(items: T[]): T => {
  const [item] = items;
  if (item === undefined) {
    throw new Error("expected a row");
  }
  return item;
};

interface AppRow {
  agent_id: string;
  app_id: string;
  bot_token: string;
  bot_user_id: string;
  id: string;
  signing_secret: string;
  status: string;
  team_id: string;
  workspace_id: string;
}

interface LinkRow {
  clerk_user_id: string;
  email: string;
  external_user_id: string;
  provider: string;
  team_id: string;
  workspace_id: string;
}

const appRows = (db: Db): AppRow[] =>
  db.client.query<AppRow, []>("SELECT * FROM slack_apps").all();

const linkRows = (db: Db): LinkRow[] =>
  db.client.query<LinkRow, []>("SELECT * FROM identity_links").all();

test("seeds an installed app whose secrets decrypt with their bindings", async () => {
  const db = setup();
  await seedSlackApp(input(db));

  const app = one(appRows(db));
  expect(appRows(db)).toHaveLength(1);
  expect(app).toMatchObject({
    agent_id: AGENT,
    app_id: "A0APP",
    bot_user_id: "U0BOT",
    status: "installed",
    team_id: "T0TEAM",
    workspace_id: WORKSPACE,
  });

  const key = await importSecretsKey(SECRETS_KEY);
  const row = { id: app.id, workspaceId: WORKSPACE };
  expect(
    await decryptSecret(
      key,
      slackSecretBinding(row, "signing_secret"),
      app.signing_secret
    )
  ).toBe(SECRET);
  expect(
    await decryptSecret(
      key,
      slackSecretBinding(row, "bot_token"),
      app.bot_token
    )
  ).toBe("xoxb-dev");
});

test("seeds the sender's identity link to the Clerk user", async () => {
  const db = setup();
  await seedSlackApp(input(db, { clerkUserId: "user_42" }));

  expect(linkRows(db)).toHaveLength(1);
  expect(one(linkRows(db))).toMatchObject({
    clerk_user_id: "user_42",
    email: "dev@example.com",
    external_user_id: "U0DOM",
    provider: "slack",
    team_id: "T0TEAM",
    workspace_id: WORKSPACE,
  });
});

test("running it twice leaves one app row and one link", async () => {
  const db = setup();
  await seedSlackApp(input(db, { clerkUserId: "user_first" }));
  const firstId = one(appRows(db)).id;
  await seedSlackApp(
    input(db, { clerkUserId: "user_second", secret: "signing-secret-two" })
  );

  const app = one(appRows(db));
  expect(appRows(db)).toHaveLength(1);
  expect(app.id).not.toBe(firstId);

  const key = await importSecretsKey(SECRETS_KEY);
  expect(
    await decryptSecret(
      key,
      slackSecretBinding(
        { id: app.id, workspaceId: WORKSPACE },
        "signing_secret"
      ),
      app.signing_secret
    )
  ).toBe("signing-secret-two");

  expect(linkRows(db)).toHaveLength(1);
  expect(one(linkRows(db)).clerk_user_id).toBe("user_first");
});

test("an unknown agent is refused and nothing is written", async () => {
  const db = setup();
  await expect(
    seedSlackApp(input(db, { agentId: "agent_missing" }))
  ).rejects.toThrow("No agent agent_missing in this dev workspace.");

  expect(appRows(db)).toHaveLength(0);
  expect(linkRows(db)).toHaveLength(0);
});
