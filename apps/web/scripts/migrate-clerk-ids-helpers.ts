/**
 * Helpers for migrate-clerk-ids.ts, the one-off script that rewrites Clerk org
 * and user ids in the database when the app moves from one Clerk instance to
 * another (X.1: dev instance to the shared production instance).
 *
 * It does not keep a list of columns. It reads the schema, scans every text
 * column for `user_...` and `org_...` tokens, and rewrites each mapped token
 * with REPLACE, so ids inside JSON (event payloads) and in `workspaces.name`
 * are covered, and a column added later is covered too. A token the mapping
 * does not know is reported and blocks `--apply`.
 */
import type { Database } from "bun:sqlite";

type Row = Record<string, unknown>;

export interface Driver {
  /** Runs the write statements in order, all or none where the database can. */
  exec: (statements: string[]) => Promise<void>;
  /** Runs the SELECTs in order and returns one row list per statement. */
  select: (statements: string[]) => Promise<Row[][]>;
}

export interface Occurrence {
  column: string;
  /** The `id` column when the table has one, else the rowid. */
  key: string;
  table: string;
  token: string;
}

export interface Change {
  column: string;
  key: string;
  newId: string;
  oldId: string;
  table: string;
}

export interface Plan {
  /** Tokens already equal to a new id, left alone. */
  alreadyMapped: number;
  changes: Change[];
  /** Cells holding an id from the ignore list, left alone. */
  ignored: number;
  /** Reasons the plan can't be applied. */
  problems: string[];
  /** Write statements for `changes`, empty when there are none. */
  statements: string[];
  unmapped: Occurrence[];
}

// A Clerk id is user_ or org_ plus 27 base62 characters, and not part of a
// longer identifier. Anything else that starts with user_ or org_ is not one:
// the enum value `user_or_agent`, or a path like `/mcp/org_user_<id>`.
const CLERK_ID = "(?:user|org)_[A-Za-z0-9]{27}";
const ID = new RegExp(`^${CLERK_ID}$`);
const TOKEN = new RegExp(`(?<![A-Za-z0-9_])${CLERK_ID}(?![A-Za-z0-9_])`, "g");

// events is append-only: these two triggers, created at the end of
// 0000_init.sql, block UPDATE and DELETE. The script drops them around its
// UPDATE and puts them back. Pinned against the real migrations in the tests.
const EVENTS_TRIGGER_NAMES = ["events_no_delete", "events_no_update"];
const EVENTS_TRIGGERS = [
  [
    "CREATE TRIGGER `events_no_update` BEFORE UPDATE ON `events`",
    "BEGIN",
    "\tSELECT RAISE(ABORT, 'events is append-only');",
    "END;",
  ].join("\n"),
  [
    "CREATE TRIGGER `events_no_delete` BEFORE DELETE ON `events`",
    "BEGIN",
    "\tSELECT RAISE(ABORT, 'events is append-only');",
    "END;",
  ].join("\n"),
];

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** The mapping file. `email` and `name` are notes for whoever reads it. */
export interface MappingFile {
  /** Ids of other systems that look like Clerk ids. Left untouched. */
  ignore?: string[];
  orgs: Record<string, { id: string; name?: string }>;
  users: Record<string, { email?: string; id: string }>;
}

export type IdMap = ReadonlyMap<string, string>;

export interface Mapping {
  ids: IdMap;
  ignore: ReadonlySet<string>;
}

const entries = (
  section: unknown,
  prefix: "org" | "user"
): [string, string][] => {
  if (typeof section !== "object" || section === null) {
    throw new Error(`The mapping needs an "${prefix}s" object.`);
  }
  return Object.entries(section).map(([oldId, value]) => {
    const newId =
      typeof value === "object" && value !== null
        ? (value as { id?: unknown }).id
        : value;
    if (
      !(
        ID.test(oldId) &&
        oldId.startsWith(`${prefix}_`) &&
        typeof newId === "string" &&
        ID.test(newId) &&
        newId.startsWith(`${prefix}_`)
      )
    ) {
      throw new Error(
        `Bad ${prefix} mapping for ${oldId}: both sides must be ${prefix}_ ids.`
      );
    }
    if (oldId === newId) {
      throw new Error(`${oldId} maps to itself.`);
    }
    return [oldId, newId];
  });
};

export const ignoreList = (value: unknown): string[] => {
  if (value === undefined) {
    return [];
  }
  if (
    !(
      Array.isArray(value) &&
      value.every((id) => typeof id === "string" && ID.test(id))
    )
  ) {
    throw new Error('"ignore" must be a list of user_ and org_ ids.');
  }
  return value;
};

/** Parses the mapping file: the old to new id map, and the ids to leave alone. */
export const parseMapping = (text: string, invert = false): Mapping => {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("The mapping file must be a JSON object.");
  }
  const { ignore, orgs, users } = parsed as Record<string, unknown>;
  const pairs = [...entries(orgs, "org"), ...entries(users, "user")];
  const forward = new Map(pairs);
  if (new Set(forward.values()).size !== forward.size) {
    throw new Error("Two old ids map to the same new id.");
  }
  for (const newId of forward.values()) {
    if (forward.has(newId)) {
      throw new Error(`${newId} is both an old and a new id.`);
    }
  }
  const ignored = new Set(ignoreList(ignore));
  for (const id of ignored) {
    if (forward.has(id) || [...forward.values()].includes(id)) {
      throw new Error(`${id} is both mapped and ignored.`);
    }
  }
  return {
    ids: invert ? new Map(pairs.map(([a, b]) => [b, a])) : forward,
    ignore: ignored,
  };
};

const SKIP_TABLES = "m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'";

/** Every text-affinity column of every table the app owns. */
export const COLUMNS_SQL = `SELECT m.name AS tbl, p.name AS col FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND ${SKIP_TABLES} AND m.name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND m.name <> 'd1_migrations' AND (p.type = '' OR upper(p.type) LIKE '%TEXT%' OR upper(p.type) LIKE '%CHAR%' OR upper(p.type) LIKE '%CLOB%') ORDER BY m.name, p.cid`;

const TRIGGERS_SQL =
  "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'events' ORDER BY name";

const hasToken = (column: string): string =>
  `instr(${quote(column)}, 'user_') > 0 OR instr(${quote(column)}, 'org_') > 0`;

const scanSql = (table: string, columns: string[]): string => {
  const picked = columns.map(
    (column) =>
      `CASE WHEN ${hasToken(column)} THEN ${quote(column)} END AS ${quote(column)}`
  );
  const idColumn = columns.includes("id") ? [`${quote("id")} AS "__id"`] : [];
  return `SELECT rowid AS "__rowid", ${[...idColumn, ...picked].join(", ")} FROM ${quote(table)} WHERE ${columns.map(hasToken).join(" OR ")}`;
};

export interface Snapshot {
  eventsTriggers: string[];
  occurrences: Occurrence[];
}

const groupColumns = (rows: Row[]): Map<string, string[]> => {
  const byTable = new Map<string, string[]>();
  for (const row of rows) {
    const table = String(row.tbl);
    byTable.set(table, [...(byTable.get(table) ?? []), String(row.col)]);
  }
  return byTable;
};

const occurrencesIn = (
  table: string,
  columns: string[],
  rows: Row[]
): Occurrence[] =>
  rows.flatMap((row) => {
    const key = String(row.__id ?? row.__rowid);
    return columns.flatMap((column) => {
      const value = row[column];
      return typeof value === "string"
        ? [...value.matchAll(TOKEN)].map(([token]) => ({
            column,
            key,
            table,
            token,
          }))
        : [];
    });
  });

/** Reads every Clerk-looking token in the database, with where it sits. */
export const discover = async (driver: Driver): Promise<Snapshot> => {
  const [columnRows] = await driver.select([COLUMNS_SQL]);
  const byTable = groupColumns(columnRows ?? []);
  const tables = [...byTable.keys()];
  const results = await driver.select([
    ...tables.map((table) => scanSql(table, byTable.get(table) ?? [])),
    TRIGGERS_SQL,
  ]);
  return {
    eventsTriggers: (results[tables.length] ?? []).map((row) =>
      String(row.name)
    ),
    occurrences: tables.flatMap((table, index) =>
      occurrencesIn(table, byTable.get(table) ?? [], results[index] ?? [])
    ),
  };
};

const sqlText = (value: string): string => `'${value}'`;

const buildStatements = (changes: Change[]): string[] => {
  const targets = new Map<string, Change>();
  for (const change of changes) {
    targets.set(`${change.table}\0${change.column}\0${change.oldId}`, change);
  }
  const updates = [...targets.values()].map(
    ({ column, newId, oldId, table }) =>
      `UPDATE ${quote(table)} SET ${quote(column)} = REPLACE(${quote(column)}, ${sqlText(oldId)}, ${sqlText(newId)}) WHERE instr(${quote(column)}, ${sqlText(oldId)}) > 0;`
  );
  if (updates.length === 0) {
    return [];
  }
  const touchesEvents = changes.some((change) => change.table === "events");
  return [
    ...(touchesEvents
      ? EVENTS_TRIGGER_NAMES.map(
          (name) => `DROP TRIGGER IF EXISTS \`${name}\`;`
        )
      : []),
    ...updates,
    ...(touchesEvents ? EVENTS_TRIGGERS : []),
  ];
};

/** Works out what to rewrite and what stops the rewrite. Pure. */
export const buildPlan = (
  occurrences: Occurrence[],
  { ids: idMap, ignore }: Mapping
): Plan => {
  const newIds = new Set(idMap.values());
  const changes: Change[] = [];
  const unmapped: Occurrence[] = [];
  let alreadyMapped = 0;
  let ignored = 0;
  for (const occurrence of occurrences) {
    if (ignore.has(occurrence.token)) {
      ignored += 1;
      continue;
    }
    const newId = idMap.get(occurrence.token);
    if (newId !== undefined) {
      changes.push({
        column: occurrence.column,
        key: occurrence.key,
        newId,
        oldId: occurrence.token,
        table: occurrence.table,
      });
    } else if (newIds.has(occurrence.token)) {
      alreadyMapped += 1;
    } else {
      unmapped.push(occurrence);
    }
  }
  changes.sort(
    (a, b) =>
      a.table.localeCompare(b.table) ||
      a.key.localeCompare(b.key) ||
      a.column.localeCompare(b.column)
  );

  const problems: string[] = [];
  // A workspace row for the new org already exists next to the old one: the
  // UPDATE would break the unique index. The new one is a stray, empty
  // workspace made by a request that arrived before this script ran.
  const workspaceOrgs = new Set(
    occurrences
      .filter((o) => o.table === "workspaces" && o.column === "clerk_org_id")
      .map((o) => o.token)
  );
  for (const [oldId, newId] of idMap) {
    if (workspaceOrgs.has(oldId) && workspaceOrgs.has(newId)) {
      problems.push(
        `workspaces has rows for both ${oldId} and ${newId} (clerk_org_id is unique). Delete the stray ${newId} workspace first.`
      );
    }
  }
  if (unmapped.length > 0) {
    problems.push(
      `${unmapped.length} cell(s) hold an id with no mapping: ${[...new Set(unmapped.map((o) => o.token))].join(", ")}.`
    );
  }
  return {
    alreadyMapped,
    changes,
    ignored,
    problems,
    statements: buildStatements(changes),
    unmapped,
  };
};

/** The dry-run report: every row that changes, then what blocks it. */
export const formatPlan = (plan: Plan): string => {
  const lines = plan.changes.map(
    (c) => `${c.table}  ${c.key}  ${c.column}  ${c.oldId} -> ${c.newId}`
  );
  const tables = new Set(plan.changes.map((c) => c.table));
  const rows = new Set(plan.changes.map((c) => `${c.table}\0${c.key}`));
  lines.push(
    `${plan.changes.length} cell(s) in ${rows.size} row(s) of ${tables.size} table(s) would change; ${plan.alreadyMapped} already hold a new id; ${plan.ignored} ignored.`
  );
  for (const o of plan.unmapped) {
    lines.push(`UNMAPPED  ${o.table}  ${o.key}  ${o.column}  ${o.token}`);
  }
  for (const problem of plan.problems) {
    lines.push(`PROBLEM  ${problem}`);
  }
  return lines.join("\n");
};

export interface RunResult {
  exitCode: 0 | 1;
  report: string;
}

/**
 * Dry run unless `apply`. After an apply it reads the database again and
 * fails unless no mapped id is left and the events triggers are back.
 */
export const run = async (
  driver: Driver,
  mapping: Mapping,
  apply: boolean
): Promise<RunResult> => {
  const snapshot = await discover(driver);
  const plan = buildPlan(snapshot.occurrences, mapping);
  const report = [formatPlan(plan)];
  const triggersOk = (names: string[]): boolean =>
    names.length === EVENTS_TRIGGER_NAMES.length &&
    EVENTS_TRIGGER_NAMES.every((name) => names.includes(name));
  if (
    !(
      triggersOk(snapshot.eventsTriggers) ||
      plan.statements.some((statement) =>
        statement.startsWith("CREATE TRIGGER")
      )
    )
  ) {
    plan.problems.push(
      `events has these triggers: ${snapshot.eventsTriggers.join(", ") || "none"}. Expected ${EVENTS_TRIGGER_NAMES.join(" and ")}.`
    );
    report.push(`PROBLEM  ${plan.problems.at(-1)}`);
  }
  if (plan.problems.length > 0) {
    return { exitCode: 1, report: report.join("\n") };
  }
  if (!apply) {
    report.push("Dry run: nothing was written. Pass --apply to write.");
    return { exitCode: 0, report: report.join("\n") };
  }
  if (plan.statements.length === 0) {
    report.push("Nothing to change.");
    return { exitCode: 0, report: report.join("\n") };
  }
  await driver.exec(plan.statements);
  const after = await discover(driver);
  const left = buildPlan(after.occurrences, mapping);
  const verified =
    left.changes.length === 0 &&
    left.problems.length === 0 &&
    triggersOk(after.eventsTriggers);
  report.push(
    verified
      ? "Applied. Verified: no mapped id is left and the events triggers are in place."
      : `PROBLEM  after the write ${left.changes.length} cell(s) still hold an old id and the events triggers are ${after.eventsTriggers.join(", ") || "missing"}. Re-run the script for old ids; if the triggers are missing, recreate events_no_update and events_no_delete from packages/db/migrations/0000_init.sql.`
  );
  return { exitCode: verified ? 0 : 1, report: report.join("\n") };
};

/** A driver over a local SQLite file, for the copy of production D1 and tests. */
export const sqliteDriver = (db: Database): Driver => ({
  exec: (statements) => {
    // Not db.exec on the whole script: bun swallows an error in any statement
    // but the last.
    db.run("BEGIN");
    try {
      for (const statement of statements) {
        db.run(statement);
      }
      db.run("COMMIT");
      return Promise.resolve();
    } catch (error) {
      db.run("ROLLBACK");
      return Promise.reject(error);
    }
  },
  select: (statements) =>
    Promise.resolve(
      statements.map((statement) => db.query(statement).all() as Row[])
    ),
});

/** What the mapping builder needs from Clerk. Fakes in tests, the SDK in the CLI. */
export interface ClerkLookup {
  /**
   * The primary email of a user, or undefined when Clerk says the user does
   * not exist. Any other failure must throw.
   */
  emailOf: (userId: string) => Promise<string | undefined>;
  /** The name of an organisation, or undefined when Clerk says it doesn't exist. Any other failure must throw. */
  nameOf: (orgId: string) => Promise<string | undefined>;
  /** The ids of organisations with exactly this name. */
  orgIdsByName: (name: string) => Promise<string[]>;
  /** The ids of users with this email. */
  userIdsByEmail: (email: string) => Promise<string[]>;
}

export interface BuiltMapping {
  /** Ids added to the ignore list this run, with the reason. */
  ignored: string[];
  mapping: MappingFile;
  unresolved: string[];
}

export interface BuildOptions {
  /** Ids to skip, kept in the file's ignore list. */
  ignore?: readonly string[];
  /**
   * Put ids that the dev instance doesn't know in the ignore list instead of
   * reporting them. An id that exists on dev but has no single match on the
   * production instance is always reported: it is a real id.
   */
  ignoreUnresolved?: boolean;
}

type Resolved =
  | { id: string; kind: "org"; name: string; oldId: string }
  | { email: string; id: string; kind: "user"; oldId: string }
  | { foreign: boolean; oldId: string; why: string };

const resolveOrg = async (
  oldId: string,
  dev: Pick<ClerkLookup, "nameOf">,
  prod: Pick<ClerkLookup, "orgIdsByName">
): Promise<Resolved> => {
  const name = await dev.nameOf(oldId);
  if (name === undefined) {
    return { foreign: true, oldId, why: "not found on the dev instance" };
  }
  const [id, ...others] = await prod.orgIdsByName(name);
  return id !== undefined && others.length === 0
    ? { id, kind: "org", name, oldId }
    : {
        foreign: false,
        oldId,
        why: `${others.length + (id === undefined ? 0 : 1)} organisation(s) named "${name}" on the production instance`,
      };
};

const resolveUser = async (
  oldId: string,
  dev: Pick<ClerkLookup, "emailOf">,
  prod: Pick<ClerkLookup, "userIdsByEmail">
): Promise<Resolved> => {
  const email = (await dev.emailOf(oldId))?.toLowerCase();
  if (email === undefined) {
    return { foreign: true, oldId, why: "not found on the dev instance" };
  }
  const [id, ...others] = await prod.userIdsByEmail(email);
  return id !== undefined && others.length === 0
    ? { email, id, kind: "user", oldId }
    : {
        foreign: false,
        oldId,
        why: `${others.length + (id === undefined ? 0 : 1)} user(s) with ${email} on the production instance`,
      };
};

/**
 * Builds the mapping for the old ids found in the database: users by email,
 * organisations by name. An id that doesn't resolve to exactly one new id
 * lands in `unresolved` for a person to fill in.
 */
export const buildMapping = async (
  oldIds: string[],
  dev: Pick<ClerkLookup, "emailOf" | "nameOf">,
  prod: Pick<ClerkLookup, "orgIdsByName" | "userIdsByEmail">,
  options: BuildOptions = {}
): Promise<BuiltMapping> => {
  const ignore = new Set(options.ignore);
  const resolved = await Promise.all(
    [...new Set(oldIds)]
      .filter((oldId) => !ignore.has(oldId))
      .sort()
      .map((oldId) =>
        oldId.startsWith("org_")
          ? resolveOrg(oldId, dev, prod)
          : resolveUser(oldId, dev, prod)
      )
  );
  const mapping: MappingFile = { orgs: {}, users: {} };
  const unresolved: string[] = [];
  const ignored: string[] = [];
  for (const item of resolved) {
    if ("why" in item) {
      if (options.ignoreUnresolved && item.foreign) {
        ignore.add(item.oldId);
        ignored.push(`${item.oldId} (${item.why})`);
      } else {
        unresolved.push(`${item.oldId} (${item.why})`);
      }
    } else if (item.kind === "org") {
      mapping.orgs[item.oldId] = { id: item.id, name: item.name };
    } else {
      mapping.users[item.oldId] = { email: item.email, id: item.id };
    }
  }
  if (ignore.size > 0) {
    mapping.ignore = [...ignore].sort();
  }
  return { ignored, mapping, unresolved };
};
