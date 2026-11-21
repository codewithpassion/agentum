import { expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { migrated } from "@repo/db/test-db";
import { decryptSecret, importSecretsKey } from "@repo/services/crypto";
import { createDreamService } from "@repo/services/dream";
import { createEventsService } from "@repo/services/events";
import { createLibraryService } from "@repo/services/library";
import { memoryLibraryBlobs } from "@repo/services/library/memory";
import { createMemoryService } from "@repo/services/memory";
import { systemClock } from "@repo/services/runs/types";
import { createSkillsStoreService } from "@repo/services/skills-store";
import { memorySkillBlobs } from "@repo/services/skills-store/memory";
import { slackSecretBinding } from "@repo/services/slack/apps";
import {
  DEV_PERSON_EMAIL,
  DEV_SLACK_USER,
  SEEDED_AGENTS,
  SLACK_TEAM_ID,
} from "./fake-slack-config.ts";
import {
  clerkUserIdByEmail,
  resolveClerkUserId,
  seedSlackRoom,
} from "./seed-slack-room.ts";

const SECRETS_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
const ORG = "org_dev";
const WORKSPACE = `ws_${ORG}`;
const CLERK_USER = "user_dev";

type Db = ReturnType<typeof migrated>;

const setup = (): Db => migrated([ORG]);

const seed = (db: Db, clerkUserId = CLERK_USER) =>
  seedSlackRoom({
    clerkUserId,
    db,
    secretsKey: SECRETS_KEY,
    workspaceId: WORKSPACE,
  });

/** The only element of a list the test expects to have exactly one. */
const one = <T>(items: T[]): T => {
  const [item] = items;
  if (item === undefined) {
    throw new Error("expected a row");
  }
  return item;
};

const count = (db: Db, table: string): number =>
  db.client.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()
    ?.n ?? -1;

interface AppRow {
  agent_id: string;
  app_id: string;
  bot_token: string;
  bot_user_id: string;
  id: string;
  signing_secret: string;
  status: string;
  team_id: string;
}

const appRows = (db: Db): AppRow[] =>
  db.client.query<AppRow, []>("SELECT * FROM slack_apps ORDER BY app_id").all();

interface TeamRow {
  folder_path: string | null;
  id: string;
  lead_agent_id: string | null;
  lead_listens: number;
  name: string;
  owner_user_id: string | null;
  slug: string;
}

const teamRows = (db: Db): TeamRow[] =>
  db.client.query<TeamRow, []>("SELECT * FROM teams").all();

const agentIdBySlug = (db: Db, slug: string): string =>
  one(
    db.client
      .query<{ id: string }, [string]>("SELECT id FROM agents WHERE slug = ?")
      .all(slug)
  ).id;

test("seeds three fake agents with their own installed Slack apps", async () => {
  const db = setup();
  const summary = await seed(db);

  expect(count(db, "agents")).toBe(3);
  expect(summary.agents.map((agent) => agent.slug)).toEqual([
    "ada",
    "cy",
    "di",
  ]);
  const agentRow = db.client
    .query<{ runtime: string; model: string; name: string }, [string]>(
      "SELECT runtime, model, name FROM agents WHERE slug = ?"
    )
    .get("cy");
  expect(agentRow).toMatchObject({
    model: "fake",
    name: "Cy",
    runtime: "fake",
  });

  const apps = appRows(db);
  expect(apps.map((app) => app.app_id)).toEqual(
    SEEDED_AGENTS.map((agent) => agent.app.appId).sort()
  );
  for (const app of apps) {
    expect(app).toMatchObject({ status: "installed", team_id: SLACK_TEAM_ID });
  }
});

test("each Slack app's token and signing secret decrypt to the config's values", async () => {
  const db = setup();
  await seed(db);

  const key = await importSecretsKey(SECRETS_KEY);
  await Promise.all(
    SEEDED_AGENTS.map(async (seeded) => {
      const row = one(
        appRows(db).filter((app) => app.app_id === seeded.app.appId)
      );
      expect(row.agent_id).toBe(agentIdBySlug(db, seeded.slug));
      expect(row.bot_user_id).toBe(seeded.app.botUserId);
      const binding = { id: row.id, workspaceId: WORKSPACE };
      expect(
        await decryptSecret(
          key,
          slackSecretBinding(binding, "bot_token"),
          row.bot_token
        )
      ).toBe(seeded.app.token);
      expect(
        await decryptSecret(
          key,
          slackSecretBinding(binding, "signing_secret"),
          row.signing_secret
        )
      ).toBe(seeded.app.signingSecret);
    })
  );
});

test("links the Slack user to the Clerk user and makes the Launch team", async () => {
  const db = setup();
  const summary = await seed(db);

  expect(count(db, "identity_links")).toBe(1);
  expect(
    db.client
      .query<
        { clerk_user_id: string; email: string; external_user_id: string },
        []
      >("SELECT clerk_user_id, email, external_user_id FROM identity_links")
      .get()
  ).toEqual({
    clerk_user_id: CLERK_USER,
    email: DEV_PERSON_EMAIL,
    external_user_id: DEV_SLACK_USER,
  });

  expect(teamRows(db)).toHaveLength(1);
  expect(one(teamRows(db))).toMatchObject({
    id: summary.teamId,
    lead_agent_id: agentIdBySlug(db, "ada"),
    lead_listens: 1,
    name: "Launch",
    owner_user_id: CLERK_USER,
    slug: "launch",
  });
  expect(
    db.client
      .query<{ member_kind: string }, [string]>(
        "SELECT member_kind FROM team_members WHERE team_id = ?"
      )
      .all(summary.teamId)
      .map((row) => row.member_kind)
      .sort()
  ).toEqual(["agent", "agent", "agent", "user"]);
  expect(count(db, "team_slack_links")).toBe(0);
});

test("the Launch team has its folder, so a team dream does not refuse it", async () => {
  const db = setup();
  const { teamId } = await seed(db);

  expect(one(teamRows(db)).folder_path).toBe("teams/launch");
  expect(
    db.client
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM agent_library_access WHERE path = 'teams/launch' AND mode = 'write'"
      )
      .get()?.n
  ).toBe(3);

  const atomic = sqliteAtomic(db);
  const events = createEventsService({
    blobs: { get: () => Promise.resolve(null), put: () => Promise.resolve() },
    db,
  });
  const library = createLibraryService({
    atomic,
    blobs: memoryLibraryBlobs(),
    clock: systemClock,
    db,
    events,
  });
  const dream = createDreamService({
    atomic,
    clock: systemClock,
    db,
    events,
    fetch: () => Promise.resolve(new Response("{}", { status: 500 })),
    inbox: {
      postNotice: () =>
        Promise.resolve({ postId: "post", runs: [], threadId: "thread" }),
      retryNoticeWake: () => Promise.resolve([]),
    },
    library,
    managedKeys: { resolve: () => Promise.resolve(null) },
    memory: createMemoryService({
      atomic,
      clock: systemClock,
      db,
      events,
      library,
    }),
    skillsStore: createSkillsStoreService({
      atomic,
      blobs: memorySkillBlobs(),
      clock: systemClock,
      db,
      events,
      library,
    }),
  });
  const principal = {
    kind: "user",
    userId: CLERK_USER,
    via: "session",
    workspaceId: WORKSPACE,
  } as const;

  // A team with no folder is refused before a run is made. A dream that fails
  // after that is a `failed` run, which this test does not mind.
  await expect(dream.runTeamNow(principal, teamId)).resolves.toMatchObject({
    teamId,
  });
});

test("running it twice adds no duplicates and keeps the ids", async () => {
  const db = setup();
  const first = await seed(db);
  const appIds = appRows(db).map((app) => app.id);
  const agentIds = db.client
    .query<{ id: string }, []>("SELECT id FROM agents ORDER BY id")
    .all()
    .map((row) => row.id);

  const second = await seed(db);

  expect(second).toEqual(first);
  expect(count(db, "agents")).toBe(3);
  expect(count(db, "slack_apps")).toBe(3);
  expect(count(db, "identity_links")).toBe(1);
  expect(count(db, "teams")).toBe(1);
  expect(count(db, "team_members")).toBe(4);
  expect(appRows(db).map((app) => app.id)).toEqual(appIds);
  expect(
    db.client
      .query<{ id: string }, []>("SELECT id FROM agents ORDER BY id")
      .all()
      .map((row) => row.id)
  ).toEqual(agentIds);
});

test("a rerun repairs missing member, app and link rows", async () => {
  const db = setup();
  const { teamId } = await seed(db);
  const droppedApp = one(appRows(db));
  db.client.run("DELETE FROM team_members WHERE member_kind = 'user'");
  db.client.run("DELETE FROM slack_apps WHERE id = ?", [droppedApp.id]);
  db.client.run("DELETE FROM identity_links");

  await seed(db);

  expect(count(db, "slack_apps")).toBe(3);
  expect(count(db, "identity_links")).toBe(1);
  expect(
    db.client
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM team_members WHERE team_id = ? AND member_kind = 'user'"
      )
      .get(teamId)?.n
  ).toBe(1);
});

test("a rerun keeps an app row that Slack messages reference", async () => {
  const db = setup();
  await seed(db);
  const app = one(appRows(db));
  db.client.run(
    "INSERT INTO slack_messages (app_id, channel_id, created_at, id, slack_user_id, text, ts, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [
      app.id,
      "C0SL5ROOM",
      "2026-01-01T00:00:00.000Z",
      "msg_1",
      DEV_SLACK_USER,
      "hello",
      "1.000001",
      WORKSPACE,
    ]
  );

  await seed(db);

  expect(count(db, "slack_apps")).toBe(3);
  expect(one(appRows(db).filter((row) => row.id === app.id)).app_id).toBe(
    app.app_id
  );
});

test("a rerun points an existing identity link at the given Clerk user", async () => {
  const db = setup();
  await seed(db, "user_first");
  await seed(db, "user_second");

  expect(count(db, "identity_links")).toBe(1);
  expect(
    db.client
      .query<{ clerk_user_id: string }, []>(
        "SELECT clerk_user_id FROM identity_links"
      )
      .get()?.clerk_user_id
  ).toBe("user_second");
});

test("a rerun removes a channel link so the room starts unlinked", async () => {
  const db = setup();
  const { teamId } = await seed(db);
  db.client.run(
    "INSERT INTO team_slack_links (channel_id, created_at, id, linked_by, slack_team_id, team_id, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      "C0SL5ROOM",
      "2026-01-01T00:00:00.000Z",
      "link_1",
      CLERK_USER,
      SLACK_TEAM_ID,
      teamId,
      WORKSPACE,
    ]
  );

  await seed(db);

  expect(count(db, "team_slack_links")).toBe(0);
});

test("the Clerk id is the flag when given, without a lookup", async () => {
  const id = await resolveClerkUserId({
    clerkUser: "user_flag",
    lookupClerkUser: () => {
      throw new Error("lookup should not run");
    },
    readEnv: () => undefined,
  });
  expect(id).toBe("user_flag");
});

test("without the flag the id comes from the dev login email", async () => {
  const calls: string[] = [];
  const env: Record<string, string> = {
    CLERK_SECRET_KEY: "sk_test_value",
    DEV_LOGIN_EMAIL: "dev+room@example.test",
  };
  const id = await resolveClerkUserId({
    clerkUser: undefined,
    lookupClerkUser: (email, secretKey) => {
      calls.push(`${email}|${secretKey}`);
      return Promise.resolve("user_looked_up");
    },
    readEnv: (key) => env[key],
  });
  expect(id).toBe("user_looked_up");
  expect(calls).toEqual(["dev+room@example.test|sk_test_value"]);
});

test("without the flag and without the env values, it says to pass one", async () => {
  await expect(
    resolveClerkUserId({
      clerkUser: undefined,
      lookupClerkUser: () => Promise.resolve("user_never"),
      readEnv: (key) =>
        key === "DEV_LOGIN_EMAIL" ? "dev@example.test" : undefined,
    })
  ).rejects.toThrow("Pass --clerk-user <id>");
});

test("a lookup that finds no user says to pass one", async () => {
  await expect(
    resolveClerkUserId({
      clerkUser: undefined,
      lookupClerkUser: () => Promise.resolve(null),
      readEnv: (key) =>
        key === "CLERK_SECRET_KEY" ? "sk" : "dev@example.test",
    })
  ).rejects.toThrow("Pass --clerk-user <id>");
});

test("the Clerk lookup is a read of the users list with the plus address encoded", async () => {
  const requests: { auth: string | null; url: string }[] = [];
  const stubFetch = ((input: URL | RequestInfo, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    requests.push({
      auth: headers.get("Authorization"),
      url: String(input),
    });
    return Promise.resolve(
      new Response(JSON.stringify([{ id: "user_abc" }]), { status: 200 })
    );
  }) as typeof fetch;

  const id = await clerkUserIdByEmail(
    "dev+room@example.test",
    "sk_test_value",
    stubFetch
  );

  expect(id).toBe("user_abc");
  expect(requests).toEqual([
    {
      auth: "Bearer sk_test_value",
      url: "https://api.clerk.com/v1/users?email_address=dev%2Broom%40example.test",
    },
  ]);
});

/** A fetch that answers every request with `response`. */
const fetchAnswering = (response: Response): typeof fetch =>
  ((_input: URL | RequestInfo, _init?: RequestInit) =>
    Promise.resolve(response)) as typeof fetch;

test("the Clerk lookup returns null for an empty list and throws on HTTP errors", async () => {
  const empty = fetchAnswering(new Response("[]", { status: 200 }));
  expect(await clerkUserIdByEmail("dev@example.test", "sk", empty)).toBeNull();

  const refused = fetchAnswering(new Response("nope", { status: 401 }));
  await expect(
    clerkUserIdByEmail("dev@example.test", "sk", refused)
  ).rejects.toThrow("HTTP 401");
});
