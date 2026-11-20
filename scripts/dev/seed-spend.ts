#!/usr/bin/env bun
// Seeds the local database that `bun run dev` in apps/web uses for the spend
// walkthrough (SP.5): two fake-runtime agents, a workspace timezone, finished
// runs with known costs, dream runs with token counts priced like the real
// dream (claude-haiku-5-5, $0.10 in and $0.50 out per million tokens), one team
// dream, and an active mailbox for the first agent so mail can be replayed
// through `/cdn-cgi/handler/email`. The mailbox row is written directly: going
// through the app would ask Cloudflare for a real Email Routing rule.
// Progress goes to stderr, a JSON summary with the hand sums to stdout. Run
// from the repo root, after one dev login has made the workspace:
// `bun scripts/dev/seed-spend.ts [--timezone Australia/Sydney] [--mail-domain agents.rockyshoreslabs.io]`.
import type { Database as Sqlite } from "bun:sqlite";
import { parseArgs } from "node:util";
import { createAgentsService } from "@repo/services/agents";
import {
  devUserPrincipal,
  localEvents,
  openLocalDatabase,
  openSqlite,
  requireOrgId,
  runCli,
} from "./local.ts";

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const OFFSET_PATTERN = /GMT([+-])(\d{2}):(\d{2})/;
const SEED_USER = "seed-spend";
export const DEFAULT_TIMEZONE = "Australia/Sydney";
/** The `MAIL_DOMAIN` in apps/web/wrangler.jsonc. The address has to match it. */
export const DEFAULT_MAIL_DOMAIN = "agents.rockyshoreslabs.io";
export const MAIL_LOCAL = "sp5-local-echo";
const DAYS_PER_WEEK = 7;
const MILLION = 1_000_000;
// claude-haiku-5-5, USD per million tokens. Written out here, not imported from
// the dream, so the walkthrough prices a dream independently of the code it checks.
const DREAM_INPUT_USD = 0.1;
const DREAM_OUTPUT_USD = 0.5;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const BASE = 32;
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;

/** A ULID at the given time. `ulidx` is not a dependency of the repo root. */
const ulid = (time: number): string => {
  let stamp = "";
  let rest = time;
  for (let i = 0; i < TIME_CHARS; i += 1) {
    stamp = `${CROCKFORD[rest % BASE]}${stamp}`;
    rest = Math.floor(rest / BASE);
  }
  const random = crypto.getRandomValues(new Uint8Array(RANDOM_CHARS));
  return stamp + [...random].map((byte) => CROCKFORD[byte % BASE]).join("");
};

/** The zone's offset from UTC in minutes at `at`, read from Intl so no zone is hard-coded. */
export const offsetMinutes = (timeZone: string, at: Date): number => {
  const name =
    new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
      .formatToParts(at)
      .find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const match = OFFSET_PATTERN.exec(name);
  if (!match) {
    return 0;
  }
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
};

/** Midnight (UTC clock) of the local Monday that starts the week containing `now`. */
export const localMonday = (timeZone: string, now: Date): number => {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone }).format(now);
  const start = Date.parse(`${day}T00:00:00Z`);
  const weekday = new Date(start).getUTCDay();
  return start - ((weekday + 6) % DAYS_PER_WEEK) * DAY_MS;
};

export interface SeedSpendInput {
  agentA: string;
  agentB: string;
  client: Sqlite;
  mailDomain?: string;
  now?: Date;
  timezone?: string;
  workspaceId: string;
}

interface RunSpec {
  agent: "a" | "b";
  /** Local day relative to this week's Monday, and the local time on it. */
  at: [day: number, time: string];
  cost?: number;
  dryRun?: boolean;
  status?: "done" | "failed";
  tokens?: [input: number, output: number];
}

interface DreamSpec {
  /** Null is a team dream. */
  agent: "a" | "b" | null;
  at: [day: number, time: string];
  tokens: [input: number, output: number];
}

// Costs in USD. Week -1 is last week, week 0 this one. `cost` undefined means
// a usage with tokens only, which the rollup counts as zero.
const RUNS: RunSpec[] = [
  { agent: "a", at: [-27, "10:00"], cost: 1.5 },
  { agent: "a", at: [-20, "10:00"], cost: 0.75 },
  { agent: "a", at: [-13, "09:00"], cost: 1.2 },
  { agent: "a", at: [-12, "09:00"], cost: 1 },
  { agent: "a", at: [-11, "09:00"], cost: 0.8 },
  // Three days that each sum to under half a cent: the page shows $0 for each.
  { agent: "a", at: [-6, "09:00"], cost: 0.004 },
  { agent: "a", at: [-5, "09:00"], cost: 0.004 },
  { agent: "a", at: [-4, "09:00"], cost: 0.004 },
  { agent: "a", at: [-3, "10:00"], cost: 1.5, tokens: [300_000, 60_000] },
  { agent: "a", at: [-3, "12:00"], tokens: [500_000, 100_000] },
  // A dry run is never counted.
  { agent: "a", at: [-2, "10:00"], cost: 9.99, dryRun: true },
  // Sunday 23:40 local is last week, although Monday has begun in UTC.
  { agent: "a", at: [-1, "23:40"], cost: 0.35 },
  // Monday 00:20 local is this week, although it is still Sunday in UTC.
  { agent: "a", at: [0, "00:20"], cost: 0.25 },
  { agent: "a", at: [0, "00:30"], cost: 0.3, status: "failed" },
  { agent: "a", at: [0, "00:40"], cost: 0.1 },
  { agent: "b", at: [-5, "09:00"], cost: 2 },
  { agent: "b", at: [0, "00:50"], cost: 0.45 },
];

const DREAMS: DreamSpec[] = [
  { agent: "a", at: [-2, "08:00"], tokens: [1_000_000, 200_000] },
  { agent: "a", at: [0, "01:00"], tokens: [2_000_000, 400_000] },
  { agent: "b", at: [0, "01:05"], tokens: [500_000, 100_000] },
  { agent: null, at: [0, "01:10"], tokens: [3_000_000, 600_000] },
];

/** What a dream of this size costs, priced the way `dream/model.ts` prices it. */
export const dreamCost = ([input, output]: [number, number]): number =>
  (input * DREAM_INPUT_USD + output * DREAM_OUTPUT_USD) / MILLION;

/**
 * Writes the rows. Idempotent: runs carry a request id and dream runs a fixed
 * id per spec, so a second call adds nothing. Returns the number of runs and
 * dream runs the call inserted.
 */
export const seedSpend = ({
  agentA,
  agentB,
  client,
  mailDomain = DEFAULT_MAIL_DOMAIN,
  now = new Date(),
  timezone = DEFAULT_TIMEZONE,
  workspaceId,
}: SeedSpendInput): { dreams: number; runs: number } => {
  const monday = localMonday(timezone, now);
  const offset = offsetMinutes(timezone, now);
  const instant = ([day, time]: [number, string]): string => {
    const [hours = 0, minutes = 0] = time.split(":").map(Number);
    const local = monday + day * DAY_MS + (hours * 60 + minutes) * MINUTE_MS;
    return new Date(local - offset * MINUTE_MS).toISOString();
  };
  const agentIds = { a: agentA, b: agentB };

  client.run("UPDATE workspaces SET timezone = ? WHERE id = ?", [
    timezone,
    workspaceId,
  ]);

  const sessionOf = new Map<string, string>();
  for (const agentId of [agentA, agentB]) {
    const existing = client
      .query<{ id: string }, [string, string]>(
        "SELECT id FROM sessions WHERE agent_id = ? AND external_key = ?"
      )
      .get(agentId, "seed-spend");
    const id = existing?.id ?? ulid(Date.now());
    if (!existing) {
      client.run(
        "INSERT INTO sessions (id, actor_id, actor_kind, agent_id, created_at, external_key, origin, workspace_id) VALUES (?, ?, 'user', ?, ?, 'seed-spend', 'ui', ?)",
        [id, SEED_USER, agentId, now.toISOString(), workspaceId]
      );
    }
    sessionOf.set(agentId, id);
  }

  let runs = 0;
  for (const [index, spec] of RUNS.entries()) {
    const agentId = agentIds[spec.agent];
    const at = instant(spec.at);
    const usage = JSON.stringify({
      ...(spec.cost === undefined ? {} : { costUsd: spec.cost }),
      ...(spec.tokens
        ? { inputTokens: spec.tokens[0], outputTokens: spec.tokens[1] }
        : {}),
    });
    const changes = client.run(
      "INSERT OR IGNORE INTO runs (id, actor_id, actor_kind, agent_id, created_at, dry_run, finished_at, input_text, request_id, session_id, started_at, status, usage, workspace_id) VALUES (?, ?, 'user', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        ulid(Date.parse(at)),
        SEED_USER,
        agentId,
        at,
        spec.dryRun ? 1 : 0,
        at,
        "Seeded run for the spend walkthrough",
        `seed-spend:run:${index}`,
        sessionOf.get(agentId) ?? "",
        at,
        spec.status ?? "done",
        usage,
        workspaceId,
      ]
    );
    runs += changes.changes;
  }

  const teamId = ensureTeam(client, workspaceId, now);
  let dreams = 0;
  for (const [index, spec] of DREAMS.entries()) {
    const at = instant(spec.at);
    const [inputTokens, outputTokens] = spec.tokens;
    const changes = client.run(
      'INSERT OR IGNORE INTO dream_runs (id, agent_id, team_id, counts, diary, finished_at, started_at, status, usage, workspace_id) VALUES (?, ?, ?, \'{"added":0,"merged":0,"dropped":0,"questions":0}\', \'Seeded dream for the spend walkthrough.\', ?, ?, \'done\', ?, ?)',
      [
        `seed-spend-dream-${index}`,
        spec.agent === null ? null : agentIds[spec.agent],
        spec.agent === null ? teamId : null,
        at,
        at,
        JSON.stringify({
          costUsd: dreamCost(spec.tokens),
          inputTokens,
          outputTokens,
        }),
        workspaceId,
      ]
    );
    dreams += changes.changes;
  }

  ensureMailbox(client, workspaceId, agentA, mailDomain, now);
  return { dreams, runs };
};

const ensureTeam = (client: Sqlite, workspaceId: string, now: Date): string => {
  const existing = client
    .query<{ id: string }, [string, string]>(
      "SELECT id FROM teams WHERE workspace_id = ? AND slug = ?"
    )
    .get(workspaceId, "seed-spend-team");
  if (existing) {
    return existing.id;
  }
  const id = ulid(now.getTime());
  client.run(
    "INSERT INTO teams (id, created_at, name, slug, workspace_id) VALUES (?, ?, 'Spend seed team', 'seed-spend-team', ?)",
    [id, now.toISOString(), workspaceId]
  );
  return id;
};

/** The mailbox as `mail.agent.provision` leaves it when routing succeeds, minus the Cloudflare call. */
const ensureMailbox = (
  client: Sqlite,
  workspaceId: string,
  agentId: string,
  domain: string,
  now: Date
): void => {
  const existing = client
    .query<{ id: string }, [string]>(
      "SELECT id FROM agent_mailboxes WHERE agent_id = ?"
    )
    .get(agentId);
  if (existing) {
    return;
  }
  const id = ulid(now.getTime());
  client.run("UPDATE agents SET email_local = ? WHERE id = ?", [
    MAIL_LOCAL,
    agentId,
  ]);
  client.run(
    "INSERT INTO agent_mailboxes (id, address, agent_id, created_at, routing_rule_id, status, workspace_id) VALUES (?, ?, ?, ?, 'local-seed', 'active', ?)",
    [id, `${MAIL_LOCAL}@${domain}`, agentId, now.toISOString(), workspaceId]
  );
  client.run(
    "INSERT OR IGNORE INTO triggers (id, agent_id, created_at, created_by, kind, name, workspace_id) VALUES (?, ?, ?, ?, 'mail', 'Mail', ?)",
    [`mail:${id}`, agentId, now.toISOString(), SEED_USER, workspaceId]
  );
};

export const main = async (): Promise<void> => {
  const { values } = parseArgs({
    options: {
      "mail-domain": { default: DEFAULT_MAIL_DOMAIN, type: "string" },
      timezone: { default: DEFAULT_TIMEZONE, type: "string" },
    },
  });
  const orgId = requireOrgId();
  const local = openLocalDatabase();
  process.stderr.write(`Seeding ${local.file}.\n`);
  const ids = await (async () => {
    try {
      const workspace = await devUserPrincipal(local.db, orgId);
      const agents = createAgentsService({
        db: local.db,
        events: localEvents(local.db),
      });
      const principal = { ...workspace, userId: SEED_USER };
      const known = await agents.list(principal, { includeArchived: true });
      const ensure = async (slug: string, name: string): Promise<string> => {
        const found = known.find((agent) => agent.slug === slug);
        if (found) {
          return found.id;
        }
        const created = await agents.create(principal, {
          instructions: "Echoes whatever it is told.",
          model: "fake",
          name,
          runtime: "fake",
          slug,
        });
        return created.id;
      };
      return {
        agentA: await ensure("fake-echo", "Fake echo"),
        agentB: await ensure("fake-second", "Fake second"),
        workspaceId: workspace.workspaceId,
      };
    } finally {
      local.close();
    }
  })();

  const client = openSqlite(local.file);
  try {
    const counts = seedSpend({
      ...ids,
      client,
      mailDomain: values["mail-domain"],
      timezone: values.timezone,
    });
    process.stderr.write(
      `Inserted ${counts.runs} runs and ${counts.dreams} dream runs.\n`
    );
  } finally {
    client.close();
  }
  process.stdout.write(
    `${JSON.stringify({ agentA: ids.agentA, agentB: ids.agentB, mail: `${MAIL_LOCAL}@${values["mail-domain"]}` })}\n`
  );
};

if (import.meta.main) {
  runCli(main);
}
