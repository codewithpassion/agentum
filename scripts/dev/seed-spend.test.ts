import { expect, test } from "bun:test";
import { migrated } from "@repo/db/test-db";
import {
  DEFAULT_MAIL_DOMAIN,
  dreamCost,
  localMonday,
  MAIL_LOCAL,
  offsetMinutes,
  seedSpend,
} from "./seed-spend.ts";

const WORKSPACE = "ws_dev";
const AGENT_A = "agent_a";
const AGENT_B = "agent_b";
const TIMEZONE = "Australia/Sydney";
const NOW = new Date("2026-11-20T13:57:00.000Z");
const RUN_COUNT = 17;
const DREAM_COUNT = 4;

type Db = ReturnType<typeof migrated>;

interface Usage {
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}

interface RunRow {
  agent_id: string;
  created_at: string;
  dry_run: number;
  id: string;
  request_id: string;
  usage: string;
}

interface DreamRow {
  agent_id: string | null;
  id: string;
  team_id: string | null;
  usage: string;
}

interface MailboxRow {
  address: string;
  agent_id: string;
  id: string;
  status: string;
}

interface TriggerRow {
  agent_id: string;
  id: string;
  kind: string;
}

interface AgentRow {
  email_local: string | null;
  id: string;
}

interface WorkspaceRow {
  timezone: string;
}

/** The only element of a list the test expects to have exactly one. */
const one = <T>(items: T[]): T => {
  const [item] = items;
  if (item === undefined) {
    throw new Error("expected a row");
  }
  return item;
};

const setup = (): Db => {
  const db = migrated();
  db.client.run(
    "INSERT INTO workspaces (id, clerk_org_id, name, timezone, created_at) VALUES (?, ?, ?, ?, ?)",
    [WORKSPACE, "org_dev", "Dev Workspace", "UTC", "2026-01-01T00:00:00.000Z"]
  );
  for (const [id, slug, name] of [
    [AGENT_A, "fake-echo", "Fake echo"],
    [AGENT_B, "fake-second", "Fake second"],
  ]) {
    db.client.run(
      "INSERT INTO agents (id, created_at, created_by, instructions, model, name, runtime, runtime_config, slug, status, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        "2026-01-01T00:00:00.000Z",
        "user_dev",
        "Echoes whatever it is told.",
        "fake",
        name,
        "fake",
        "{}",
        slug,
        "active",
        WORKSPACE,
      ]
    );
  }
  return db;
};

const seed = (db: Db) =>
  seedSpend({
    agentA: AGENT_A,
    agentB: AGENT_B,
    client: db.client,
    now: NOW,
    timezone: TIMEZONE,
    workspaceId: WORKSPACE,
  });

const runRows = (db: Db): RunRow[] =>
  db.client.query<RunRow, []>("SELECT * FROM runs").all();

const runByRequest = (db: Db, requestId: string): RunRow =>
  one(
    db.client
      .query<RunRow, [string]>("SELECT * FROM runs WHERE request_id = ?")
      .all(requestId)
  );

const dreamByRequest = (db: Db, id: string): DreamRow =>
  one(
    db.client
      .query<DreamRow, [string]>("SELECT * FROM dream_runs WHERE id = ?")
      .all(id)
  );

const usageOf = (row: { usage: string }): Usage => {
  const usage: Usage = JSON.parse(row.usage);
  return usage;
};

test("offsetMinutes reads the zone offset, and UTC is zero", () => {
  const at = new Date("2026-11-20T00:00:00Z");
  expect(offsetMinutes("Australia/Sydney", at)).toBe(660);
  expect(offsetMinutes("UTC", at)).toBe(0);
});

test("localMonday is the Monday of the local week, switching at local midnight", () => {
  const monday = Date.UTC(2026, 10, 16);
  expect(localMonday(TIMEZONE, NOW)).toBe(monday);
  // Sunday 23:59 in Sydney is still last week's Sunday, so the week starts 16 Nov.
  expect(localMonday(TIMEZONE, new Date("2026-11-22T12:59:00Z"))).toBe(monday);
  // Monday 00:00 in Sydney starts the next week.
  expect(localMonday(TIMEZONE, new Date("2026-11-22T13:00:00Z"))).toBe(
    Date.UTC(2026, 10, 23)
  );
});

test("dreamCost prices tokens at claude-haiku-5-5 rates", () => {
  expect(dreamCost([2_000_000, 400_000])).toBeCloseTo(0.4, 10);
  expect(dreamCost([1_000_000, 200_000])).toBeCloseTo(0.2, 10);
});

test("the first call inserts every run and dream, the second inserts none", () => {
  const db = setup();
  expect(seed(db)).toEqual({ dreams: DREAM_COUNT, runs: RUN_COUNT });
  expect(seed(db)).toEqual({ dreams: 0, runs: 0 });
  expect(runRows(db)).toHaveLength(RUN_COUNT);
});

test("the workspace timezone is set to the seeded zone", () => {
  const db = setup();
  seed(db);
  expect(
    one(
      db.client
        .query<WorkspaceRow, [string]>(
          "SELECT timezone FROM workspaces WHERE id = ?"
        )
        .all(WORKSPACE)
    ).timezone
  ).toBe(TIMEZONE);
});

test("runs at the week boundary fall on the right side of local midnight", () => {
  const db = setup();
  seed(db);
  // Index 12: Monday 00:20 Sydney, which is still Sunday in UTC, so it is this week.
  expect(runByRequest(db, "seed-spend:run:12").created_at).toBe(
    "2026-11-15T13:20:00.000Z"
  );
  // Index 11: Sunday 23:40 Sydney, which is last week although Monday has begun in UTC.
  expect(runByRequest(db, "seed-spend:run:11").created_at).toBe(
    "2026-11-15T12:40:00.000Z"
  );
});

test("a dry run is written with dry_run set and its cost", () => {
  const db = setup();
  seed(db);
  // Index 10 is the dry run.
  const dryRun = runByRequest(db, "seed-spend:run:10");
  expect(dryRun.dry_run).toBe(1);
  expect(usageOf(dryRun).costUsd).toBe(9.99);
});

test("a run with tokens and no cost has no costUsd key", () => {
  const db = setup();
  seed(db);
  // Index 9 carries tokens only.
  const tokensOnly = usageOf(runByRequest(db, "seed-spend:run:9"));
  expect(tokensOnly).not.toHaveProperty("costUsd");
  expect(tokensOnly.inputTokens).toBe(500_000);
  expect(tokensOnly.outputTokens).toBe(100_000);
});

test("dream runs carry their cost, and a team dream has no agent", () => {
  const db = setup();
  seed(db);

  const team = dreamByRequest(db, "seed-spend-dream-3");
  expect(team.agent_id).toBeNull();
  expect(team.team_id).not.toBeNull();
  expect(usageOf(team).costUsd).toBeCloseTo(0.6, 10);

  const agentDream = dreamByRequest(db, "seed-spend-dream-1");
  expect(agentDream.agent_id).toBe(AGENT_A);
  expect(usageOf(agentDream).costUsd).toBeCloseTo(0.4, 10);
});

test("agent A gets one active mailbox, a mail trigger, and the local part", () => {
  const db = setup();
  seed(db);

  const mailbox = one(
    db.client
      .query<MailboxRow, [string]>(
        "SELECT * FROM agent_mailboxes WHERE agent_id = ?"
      )
      .all(AGENT_A)
  );
  expect(
    db.client.query<MailboxRow, []>("SELECT * FROM agent_mailboxes").all()
  ).toHaveLength(1);
  expect(mailbox.status).toBe("active");
  expect(mailbox.address).toBe(`${MAIL_LOCAL}@${DEFAULT_MAIL_DOMAIN}`);

  const trigger = one(
    db.client
      .query<TriggerRow, [string]>("SELECT * FROM triggers WHERE id = ?")
      .all(`mail:${mailbox.id}`)
  );
  expect(trigger).toMatchObject({ agent_id: AGENT_A, kind: "mail" });

  const agent = one(
    db.client
      .query<AgentRow, [string]>(
        "SELECT id, email_local FROM agents WHERE id = ?"
      )
      .all(AGENT_A)
  );
  expect(agent.email_local).toBe(MAIL_LOCAL);
});
