/**
 * Pure helpers for the one-off Harbourmaster to Agentum v2 move
 * (docs/v3/agentum-v2-cutover.md). No I/O here: the CLIs next to this file do
 * the wrangler, S3 and Cloudflare API calls. Tested in helpers.test.ts.
 */

export type MoveEnv = "production" | "staging";

export interface MoveNames {
  newBucket: string;
  newD1: string;
  newWorker: string;
  oldBucket: string;
  oldD1: string;
  oldWorker: string;
}

export const NAMES: Record<MoveEnv, MoveNames> = {
  production: {
    newBucket: "agentum-v2-files",
    newD1: "agentum-v2",
    newWorker: "agentum-v2",
    oldBucket: "harbourmaster-files",
    oldD1: "harbourmaster",
    oldWorker: "harbourmaster",
  },
  staging: {
    newBucket: "agentum-v2-staging-files",
    newD1: "agentum-v2-staging",
    newWorker: "agentum-v2-staging",
    oldBucket: "harbourmaster-staging-files",
    oldD1: "harbourmaster-staging",
    oldWorker: "harbourmaster-staging",
  },
};

export interface MoveArgs {
  apply: boolean;
  env: MoveEnv;
}

/** `--env production|staging` (required) and `--apply`. Throws on anything else. */
export const parseMoveArgs = (argv: string[]): MoveArgs => {
  let env: MoveEnv | undefined;
  let apply = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--apply") {
      apply = true;
    } else if (flag === "--env") {
      const value = argv[i + 1];
      if (value !== "production" && value !== "staging") {
        throw new Error("--env takes production or staging.");
      }
      env = value;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${flag ?? ""}`);
    }
  }
  if (env === undefined) {
    throw new Error("Pass --env production or --env staging.");
  }
  return { apply, env };
};

// ---------------------------------------------------------------------------
// Durable Objects

/**
 * Every Durable Object class the Worker exports. All of them move, the
 * stateless SessionStream too, so the old Worker keeps no namespace and the
 * transfer is one uniform list.
 */
export const DO_CLASSES = [
  "MachineRelay",
  "PiRun",
  "ManagedPoller",
  "VmSession",
  "SessionStream",
  "MailboxDO",
  "AppStore",
  "ArtifactRoom",
  "LiveArtifactMaintenance",
  "GuestRun",
] as const;

/** The tag of the transfer. The old Worker's history ended at v9. */
export const TRANSFER_TAG = "v10";

type BuiltConfig = Record<string, unknown> & { name?: unknown };

/** Which environment a built config belongs to, from its Worker name. */
export const envOfWorker = (name: unknown): MoveEnv => {
  for (const env of ["production", "staging"] as const) {
    if (NAMES[env].newWorker === name) {
      return env;
    }
  }
  throw new Error(
    `The built config is for Worker ${String(name)}, not agentum-v2 or agentum-v2-staging.`
  );
};

/**
 * Turns the built `dist/server/wrangler.json` into the config of the first
 * deploy: the `exports` map goes, and a legacy migration transfers every class
 * from the old Worker. Wrangler sends every migration step to a Worker that
 * does not exist yet, so this one tag is the new Worker's whole history.
 * Throws when the config does not look like the committed one.
 */
export const transferConfig = (built: BuiltConfig): BuiltConfig => {
  const env = envOfWorker(built.name);
  const exportsMap = built.exports as Record<string, unknown> | undefined;
  const exported = Object.keys(exportsMap ?? {}).sort();
  const expected = [...DO_CLASSES].sort();
  if (exported.join(",") !== expected.join(",")) {
    throw new Error(
      `exports lists ${exported.join(", ") || "nothing"}; expected ${expected.join(", ")}.`
    );
  }
  const migrations = built.migrations as unknown[] | undefined;
  if (migrations !== undefined && migrations.length > 0) {
    throw new Error("The built config already has migrations.");
  }
  const { exports: _dropped, ...rest } = built;
  return {
    ...rest,
    migrations: [
      {
        tag: TRANSFER_TAG,
        transferred_classes: DO_CLASSES.map((name) => ({
          from: name,
          from_script: NAMES[env].oldWorker,
          to: name,
        })),
      },
    ],
  };
};

// ---------------------------------------------------------------------------
// D1

/**
 * The schema comes from `wrangler d1 migrations apply` on the new database, not
 * from the dump: a full export creates tables in name order and inserts each
 * table's rows right after it, so a child row (agents) arrives before its
 * parent table (workspaces) exists, which SQLite refuses even with deferred
 * foreign keys. The data goes in afterwards from a `--no-schema` export.
 */
export const TABLES_QUERY =
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name;";

export const MIGRATIONS_QUERY = "SELECT name FROM d1_migrations ORDER BY id;";

/** Migrations one database has applied and the other has not. */
export const migrationGap = (
  oldNames: string[],
  newNames: string[]
): string[] => {
  const inNew = new Set(newNames);
  const inOld = new Set(oldNames);
  return [
    ...oldNames
      .filter((name) => !inNew.has(name))
      .map((name) => `only old: ${name}`),
    ...newNames
      .filter((name) => !inOld.has(name))
      .map((name) => `only new: ${name}`),
  ];
};

const D1_MIGRATIONS_ROW = /^INSERT INTO [`"]?d1_migrations[`"]? /;
const SCHEMA_STATEMENT = /^(CREATE|DROP|ALTER) /;

/**
 * Checks a `wrangler d1 export --no-schema` dump and drops its `d1_migrations`
 * rows, which the new database already has from `migrations apply`. Each of
 * those rows is one line. The `sqlite_sequence` lines stay, so AUTOINCREMENT
 * counters carry over. Throws when the dump is not a data-only export.
 */
export const dataForImport = (sql: string): string => {
  const lines = sql.split("\n");
  if (lines[0]?.trim() !== "PRAGMA defer_foreign_keys=TRUE;") {
    throw new Error(
      "The dump does not start with PRAGMA defer_foreign_keys=TRUE."
    );
  }
  if (lines.some((line) => SCHEMA_STATEMENT.test(line))) {
    throw new Error(
      "The dump holds schema statements; export with --no-schema."
    );
  }
  return lines.filter((line) => !D1_MIGRATIONS_ROW.test(line)).join("\n");
};

/** Tables that already hold rows: the import needs an empty database. */
export const nonEmptyTables = (counts: Record<string, unknown>): string[] =>
  Object.keys(counts).filter((table) => Number(counts[table]) > 0);

/** One SELECT that counts the rows of every table, as one result row. */
export const countQuery = (tables: string[]): string => {
  const parts = tables.map(
    (table) => `(SELECT count(*) FROM "${table}") AS "${table}"`
  );
  return `SELECT ${parts.join(", ")};`;
};

/** Tables whose row counts differ between the old and new database. */
export const countMismatches = (
  before: Record<string, unknown>,
  after: Record<string, unknown>
): string[] =>
  Object.keys(before)
    .filter((table) => Number(before[table]) !== Number(after[table]))
    .map(
      (table) =>
        `${table}: ${String(before[table])} before, ${String(after[table] ?? "missing")} after`
    );

// ---------------------------------------------------------------------------
// R2

export interface ObjectEntry {
  key: string;
  size: number;
}

/**
 * The keys to copy: every source object the target lacks or holds at a
 * different size. Run again after a first copy, it picks up only what changed,
 * which keeps the copy inside the maintenance window short.
 */
export const planCopy = (
  source: ObjectEntry[],
  target: ObjectEntry[]
): ObjectEntry[] => {
  const have = new Map(target.map((entry) => [entry.key, entry.size]));
  return source.filter((entry) => have.get(entry.key) !== entry.size);
};

/** Keys only the target has: written by the new Worker, or left from a test. */
export const extraKeys = (
  source: ObjectEntry[],
  target: ObjectEntry[]
): string[] => {
  const have = new Set(source.map((entry) => entry.key));
  return target.map((entry) => entry.key).filter((key) => !have.has(key));
};

// ---------------------------------------------------------------------------
// Email Routing

export interface RoutingRule {
  actions: { type: string; value?: string[] }[];
  enabled?: boolean;
  id: string;
  matchers: { field?: string; type: string; value?: string }[];
  name?: string;
  priority?: number;
}

/**
 * The rules that deliver to `fromWorker`. Selected by the action, never by the
 * `harbourmaster:` name prefix: production and staging share the zone and the
 * prefix, so a name filter would point staging mailboxes at production.
 */
export const rulesForWorker = (
  rules: RoutingRule[],
  fromWorker: string
): RoutingRule[] =>
  rules.filter((rule) =>
    rule.actions.some(
      (action) =>
        action.type === "worker" &&
        action.value?.length === 1 &&
        action.value[0] === fromWorker
    )
  );

/**
 * The PUT body that points a rule at `toWorker`. The name keeps its
 * `harbourmaster:` prefix, which `email-routing.ts` uses to recognise its rules.
 */
export const repointedRule = (rule: RoutingRule, toWorker: string) => ({
  actions: rule.actions.map((action) =>
    action.type === "worker" ? { type: "worker", value: [toWorker] } : action
  ),
  enabled: rule.enabled ?? true,
  matchers: rule.matchers,
  name: rule.name,
  priority: rule.priority,
});

// ---------------------------------------------------------------------------
// Secrets

/**
 * The secret whose value must be copied unchanged: share links and live
 * artifact guest sessions are signed with it.
 */
export const KEEP_VALUE = new Set(["ARTIFACT_VIEW_KEY"]);

/**
 * Secrets the new Worker gets new values for, because the old values are lost.
 * `keys.ts` generates them, and the scrub (`SCRUB_STEPS`) clears the data only
 * the old values could read.
 */
export const ROTATED = ["RUN_TOKEN_KEY", "SECRETS_KEY"] as const;

/** Secret names from `wrangler secret list --format json` output. */
export const parseSecretNames = (output: string): string[] => {
  const start = output.indexOf("[");
  if (start === -1) {
    throw new Error("No JSON list in the wrangler output.");
  }
  const list = JSON.parse(output.slice(start)) as { name: string }[];
  return list.map((entry) => entry.name).sort();
};

const templateLine = (name: string, oldWorker: string): string => {
  if (KEEP_VALUE.has(name)) {
    return `# Same value as on ${oldWorker}, or the copied data breaks.\n${name}=`;
  }
  if ((ROTATED as readonly string[]).includes(name)) {
    return `# A new value, written by scripts/migrate-v2/keys.ts.\n${name}=`;
  }
  return `${name}=`;
};

/**
 * A `--secrets-file` template in .env format: every name with an empty value,
 * the must-keep and rotated ones marked. Holds no value, so it is safe to print.
 */
export const secretsTemplate = (names: string[], oldWorker: string): string =>
  [
    `# Secrets of ${oldWorker}, to fill in and pass to \`wrangler deploy --secrets-file\`.`,
    "# Never commit this file once it holds values.",
    ...names.map((name) => templateLine(name, oldWorker)),
    "",
  ].join("\n");

/**
 * A new value for a `ROTATED` secret: 32 random bytes, standard base64, the
 * form `importSecretsKey` and `importRunTokenKey` both read.
 */
export const newKey = (): string =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

/**
 * `file` with each of `values` on its empty `NAME=` line. Throws when a name
 * has no line or its line holds a value already, so a second run never
 * replaces a key the new Worker may be using.
 */
export const fillSecrets = (
  file: string,
  values: Record<string, string>
): string => {
  const lines = file.split("\n");
  for (const [name, value] of Object.entries(values)) {
    const at = lines.findIndex((line) => line.startsWith(`${name}=`));
    if (at === -1) {
      throw new Error(`The secrets file has no ${name}= line.`);
    }
    if (lines[at] !== `${name}=`) {
      throw new Error(`${name} has a value already. Not replacing it.`);
    }
    lines[at] = `${name}=${value}`;
  }
  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// Scrub

/**
 * Stored values only the old `SECRETS_KEY` or `RUN_TOKEN_KEY` could read.
 * `count` is a SELECT of one number: the rows `sql` changes. `sql` puts those
 * rows into the state the app already shows for a missing value, with the same
 * writes the app makes when a person removes or revokes one.
 */
export interface ScrubStep {
  count: string;
  label: string;
  sql: (now: string) => string[];
}

const sqlText = (value: string) => `'${value.replaceAll("'", "''")}'`;

/**
 * OAuth clients that hold a sealed client secret. A `shared` (Google) client
 * is sealed again on every connect, so it stays.
 */
const SEALED_CLIENT =
  "oauth IS NOT NULL AND json_valid(oauth) AND json_extract(oauth, '$.client.source') IN ('registered', 'manual') AND json_extract(oauth, '$.client.clientSecret') IS NOT NULL";

const MANAGED_TABLES = [
  "managed_sessions",
  "managed_agents",
  "managed_skills",
  "managed_skill_versions",
];

/** In foreign key order: children before parents. */
export const SCRUB_STEPS: ScrubStep[] = [
  {
    count: "SELECT count(*) FROM secrets",
    label: "workspace secrets deleted, with their agent grants",
    sql: () => ["DELETE FROM agent_secrets;", "DELETE FROM secrets;"],
  },
  {
    count: "SELECT count(*) FROM credentials WHERE status = 'ok'",
    label: "connector credentials set to needs_auth",
    sql: (now) => [
      `UPDATE credentials SET status = 'needs_auth', refreshing_until = NULL, updated_at = ${sqlText(now)}, version = version + 1 WHERE status = 'ok';`,
    ],
  },
  {
    count: `SELECT count(*) FROM connectors WHERE ${SEALED_CLIENT}`,
    label: "connector OAuth clients with a client secret removed",
    sql: () => [
      `UPDATE connectors SET oauth = json_remove(oauth, '$.client') WHERE ${SEALED_CLIENT};`,
    ],
  },
  {
    count: "SELECT count(*) FROM managed_sessions WHERE closed_at IS NULL",
    label: "open managed sessions closed",
    sql: (now) => [
      `UPDATE managed_sessions SET closed_at = ${sqlText(now)} WHERE closed_at IS NULL;`,
    ],
  },
  {
    count: "SELECT count(*) FROM workspace_anthropic_keys",
    label: "Anthropic keys deleted, with the managed ids made under them",
    sql: () => [
      ...MANAGED_TABLES.map(
        (table) =>
          `DELETE FROM ${table} WHERE workspace_id IN (SELECT workspace_id FROM workspace_anthropic_keys);`
      ),
      "DELETE FROM workspace_anthropic_keys;",
    ],
  },
  {
    count: "SELECT count(*) FROM workspace_model_keys",
    label: "model provider keys deleted",
    sql: () => ["DELETE FROM workspace_model_keys;"],
  },
  {
    count: "SELECT count(*) FROM slack_apps WHERE status <> 'revoked'",
    label: "Slack apps revoked",
    sql: () => [
      "UPDATE slack_apps SET bot_token = NULL, client_secret = NULL, status = 'revoked' WHERE status <> 'revoked';",
    ],
  },
  {
    count:
      "SELECT count(*) FROM a2a_connections WHERE outbound_credential IS NOT NULL",
    label: "A2A connections with an outbound credential revoked",
    sql: (now) => [
      `UPDATE a2a_connections SET outbound_credential = NULL, invite_token_hash = NULL, status = CASE WHEN status = 'declined' THEN status ELSE 'revoked' END, revoked_at = coalesce(revoked_at, ${sqlText(now)}), revoked_by = coalesce(revoked_by, 'system') WHERE outbound_credential IS NOT NULL;`,
    ],
  },
  {
    count:
      "SELECT count(*) FROM a2a_push_configs WHERE authentication IS NOT NULL OR token IS NOT NULL",
    label: "A2A push configs with a credential deleted",
    sql: () => [
      "DELETE FROM a2a_push_configs WHERE authentication IS NOT NULL OR token IS NOT NULL;",
    ],
  },
  {
    count: "SELECT count(*) FROM a2a_outbox",
    label: "A2A outbox deliveries deleted",
    sql: () => ["DELETE FROM a2a_outbox;"],
  },
];

/** One SELECT that counts the rows of every step, as one row keyed by label. */
export const scrubCountQuery = (): string =>
  `SELECT ${SCRUB_STEPS.map((step) => `(${step.count}) AS "${step.label}"`).join(", ")};`;

/** The whole scrub as one SQL file, for `wrangler d1 execute --file`. */
export const scrubSql = (now: string): string =>
  `${SCRUB_STEPS.flatMap((step) => step.sql(now)).join("\n")}\n`;
