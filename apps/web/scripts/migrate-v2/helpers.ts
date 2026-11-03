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
 * Secrets whose values must be copied unchanged. A new value breaks data the
 * copied database already holds: encrypted connector secrets (SECRETS_KEY),
 * run tokens (RUN_TOKEN_KEY) and share links (ARTIFACT_VIEW_KEY).
 */
export const KEEP_VALUE = new Set([
  "ARTIFACT_VIEW_KEY",
  "RUN_TOKEN_KEY",
  "SECRETS_KEY",
]);

/** Secret names from `wrangler secret list --format json` output. */
export const parseSecretNames = (output: string): string[] => {
  const start = output.indexOf("[");
  if (start === -1) {
    throw new Error("No JSON list in the wrangler output.");
  }
  const list = JSON.parse(output.slice(start)) as { name: string }[];
  return list.map((entry) => entry.name).sort();
};

/**
 * A `--secrets-file` template in .env format: every name with an empty value,
 * the must-keep ones marked. Holds no value, so it is safe to print.
 */
export const secretsTemplate = (names: string[], oldWorker: string): string =>
  [
    `# Secrets of ${oldWorker}, to fill in and pass to \`wrangler deploy --secrets-file\`.`,
    "# Never commit this file once it holds values.",
    ...names.map((name) =>
      KEEP_VALUE.has(name)
        ? `# Same value as on ${oldWorker}, or the copied data breaks.\n${name}=`
        : `${name}=`
    ),
    "",
  ].join("\n");
