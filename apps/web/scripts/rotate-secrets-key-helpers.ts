// Re-encrypts every value stored under the previous SECRETS_KEY with the
// current one (SE.4). The columns and what each value is bound to mirror the
// services that write them: `decryptSecret` binds a ciphertext to its
// workspace, table, row and field, so re-encrypting needs the same binding.
import {
  decryptSecret,
  encryptSecret,
  importSecretsKey,
  isCryptoError,
  type SecretBinding,
} from "@repo/services/crypto";

export type Row = Record<string, unknown>;

export interface Driver {
  exec: (statements: string[]) => Promise<void>;
  select: (sql: string) => Promise<Row[]>;
}

/** One ciphertext in a row, and how to put a new one back into the column. */
interface Sealed {
  binding: SecretBinding;
  /** The column's new value once this ciphertext is replaced. */
  rebuild: (stored: string) => string;
  stored: string;
}

interface Target {
  column: string;
  /** Extra columns the binding needs, selected next to the key columns. */
  extra?: string[];
  /** Primary key columns, `workspace_id` included when part of the key. */
  keyColumns: string[];
  sealed: (row: Row, value: string) => Sealed[];
  table: string;
  /** Narrows the rows, when only some of them hold ciphertext. */
  where?: string;
}

const text = (row: Row, column: string): string => {
  const value = row[column];
  if (typeof value !== "string") {
    throw new Error(`Expected text in ${column}.`);
  }
  return value;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** A column whose whole value is one ciphertext. */
const plain = (
  table: string,
  column: string,
  field: string,
  options: {
    extra?: string[];
    keyColumns?: string[];
    rowId?: (row: Row) => string;
  } = {}
): Target => {
  const rowId = options.rowId ?? ((row: Row) => text(row, "id"));
  return {
    column,
    extra: options.extra ?? [],
    keyColumns: options.keyColumns ?? ["id"],
    sealed: (row, value) => [
      {
        binding: {
          field,
          rowId: rowId(row),
          table,
          workspaceId: text(row, "workspace_id"),
        },
        rebuild: (stored) => stored,
        stored: value,
      },
    ],
    table,
  };
};

/** A JSON column holding one ciphertext, bound to `field`. */
const inJson = (
  table: string,
  column: string,
  field: string,
  accessor: {
    read: (parsed: Record<string, unknown>) => string | undefined;
    write: (parsed: Record<string, unknown>, stored: string) => void;
  },
  where?: string
): Target => ({
  column,
  keyColumns: ["id"],
  sealed: (row, value) => {
    const object = asRecord(JSON.parse(value));
    const stored = object && accessor.read(object);
    if (!(object && stored)) {
      return [];
    }
    return [
      {
        binding: {
          field,
          rowId: text(row, "id"),
          table,
          workspaceId: text(row, "workspace_id"),
        },
        rebuild: (next) => {
          accessor.write(object, next);
          return JSON.stringify(object);
        },
        stored,
      },
    ];
  },
  table,
  ...(where === undefined ? {} : { where }),
});

/** Every column the services encrypt with SECRETS_KEY. */
export const TARGETS: readonly Target[] = [
  plain("secrets", "value_enc", "value"),
  plain("credentials", "secret", "secret"),
  plain("workspace_anthropic_keys", "api_key_enc", "api_key", {
    keyColumns: ["workspace_id"],
    rowId: (row) => text(row, "workspace_id"),
  }),
  plain("workspace_model_keys", "api_key_enc", "api_key", {
    keyColumns: ["workspace_id", "provider"],
    rowId: (row) => `${text(row, "workspace_id")}:${text(row, "provider")}`,
  }),
  plain("slack_apps", "bot_token", "bot_token"),
  plain("slack_apps", "signing_secret", "signing_secret"),
  plain("a2a_connections", "outbound_credential", "outbound_credential"),
  plain("a2a_push_configs", "authentication", "authentication"),
  plain("a2a_push_configs", "token", "token"),
  plain("a2a_outbox", "headers", "headers"),
  plain("artifact_shares", "token_encrypted", "token"),
  inJson("connectors", "oauth", "oauth.clientSecret", {
    read: (parsed) => {
      const secret = asRecord(parsed.client)?.clientSecret;
      return typeof secret === "string" ? secret : undefined;
    },
    write: (parsed, stored) => {
      const client = asRecord(parsed.client);
      if (client) {
        client.clientSecret = stored;
      }
    },
  }),
  // The activation body of a pairing seals its token. Other outbox bodies are
  // plain JSON.
  inJson(
    "a2a_outbox",
    "body",
    "body.token",
    {
      read: (parsed) =>
        typeof parsed.token === "string" ? parsed.token : undefined,
      write: (parsed, stored) => {
        parsed.token = stored;
      },
    },
    "kind = 'pair_activate'"
  ),
];

const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const ident = (name: string): string => `"${name}"`;

export interface Tally {
  /** Already under the current key, or empty. */
  current: number;
  moved: number;
  /** Row keys whose value neither key opens. Ids only, never values. */
  unreadable: string[];
}

export interface Plan {
  statements: string[];
  tallies: Map<string, Tally>;
}

export interface Keys {
  current: string;
  previous: string;
}

const label = (target: Target) => `${target.table}.${target.column}`;

/** What one row needs: its new column value, or whether it cannot be read. */
const planRow = async (
  target: Target,
  row: Row,
  keys: { current: CryptoKey; previous: CryptoKey }
): Promise<{ newValue: string | null; unreadable: boolean }> => {
  const value = text(row, target.column);
  let newValue: string | null = null;
  let unreadable = false;
  for (const sealed of target.sealed(row, value)) {
    // biome-ignore lint/performance/noAwaitInLoops: a row holds one or two values
    if (await opens(keys.current, sealed)) {
      continue;
    }
    if (!(await opens(keys.previous, sealed))) {
      unreadable = true;
      continue;
    }
    const plaintext = await decryptSecret(
      keys.previous,
      sealed.binding,
      sealed.stored
    );
    newValue = sealed.rebuild(
      await encryptSecret(keys.current, sealed.binding, plaintext)
    );
  }
  return { newValue, unreadable };
};

const selectSql = (target: Target): string => {
  const columns = [
    ...new Set([
      ...target.keyColumns,
      "workspace_id",
      target.column,
      ...(target.extra ?? []),
    ]),
  ];
  const where = [`${ident(target.column)} IS NOT NULL`, target.where]
    .filter(Boolean)
    .join(" AND ");
  return `SELECT ${columns.map(ident).join(", ")} FROM ${ident(target.table)} WHERE ${where}`;
};

const updateSql = (target: Target, row: Row, newValue: string): string => {
  const keyTest = target.keyColumns
    .map((c) => `${ident(c)} = ${quote(text(row, c))}`)
    .join(" AND ");
  const column = ident(target.column);
  return `UPDATE ${ident(target.table)} SET ${column} = ${quote(newValue)} WHERE ${keyTest} AND ${column} = ${quote(text(row, target.column))};`;
};

/**
 * Reads every encrypted column and plans the update of each value the
 * current key does not open but the previous key does. Each UPDATE also
 * checks the old column value, so a row the live app changed since the read
 * is left alone and shows up on the next run.
 */
export const plan = async (driver: Driver, keys: Keys): Promise<Plan> => {
  const imported = {
    current: await importSecretsKey(keys.current),
    previous: await importSecretsKey(keys.previous),
  };
  const statements: string[] = [];
  const tallies = new Map<string, Tally>();

  for (const target of TARGETS) {
    const tally: Tally = { current: 0, moved: 0, unreadable: [] };
    tallies.set(label(target), tally);
    // biome-ignore lint/performance/noAwaitInLoops: one wrangler process at a time
    const rows = await driver.select(selectSql(target));
    for (const row of rows) {
      // biome-ignore lint/performance/noAwaitInLoops: rows are checked in order
      const { newValue, unreadable } = await planRow(target, row, imported);
      if (unreadable) {
        tally.unreadable.push(
          target.keyColumns.map((c) => text(row, c)).join("/")
        );
      }
      if (newValue !== null) {
        tally.moved += 1;
        statements.push(updateSql(target, row, newValue));
      } else if (!unreadable) {
        tally.current += 1;
      }
    }
  }
  return { statements, tallies };
};

/** Whether `key` opens the ciphertext, with no fallback to a previous key. */
const opens = async (key: CryptoKey, sealed: Sealed): Promise<boolean> => {
  try {
    await decryptSecret(key, sealed.binding, sealed.stored);
    return true;
  } catch (error: unknown) {
    if (isCryptoError(error)) {
      return false;
    }
    throw error;
  }
};

export const formatPlan = (result: Plan, apply: boolean): string => {
  const lines = [apply ? "Re-encrypting under the current key:" : "Dry run:"];
  for (const [name, tally] of result.tallies) {
    const unreadable =
      tally.unreadable.length > 0
        ? `, ${tally.unreadable.length} unreadable (${tally.unreadable.join(", ")})`
        : "";
    lines.push(
      `  ${name}: ${tally.moved} to move, ${tally.current} already current${unreadable}`
    );
  }
  return lines.join("\n");
};

/** Statements per wrangler call, to keep each file small. */
export const STATEMENTS_PER_CALL = 200;

export interface RunResult {
  exitCode: number;
  report: string;
}

export const run = async (
  driver: Driver,
  keys: Keys,
  apply: boolean
): Promise<RunResult> => {
  const result = await plan(driver, keys);
  const unreadable = [...result.tallies.values()].some(
    (tally) => tally.unreadable.length > 0
  );
  const lines = [formatPlan(result, apply)];
  if (apply) {
    for (let i = 0; i < result.statements.length; i += STATEMENTS_PER_CALL) {
      // biome-ignore lint/performance/noAwaitInLoops: one wrangler process at a time
      await driver.exec(result.statements.slice(i, i + STATEMENTS_PER_CALL));
    }
    lines.push(
      `Wrote ${result.statements.length} rows. Run it again without --apply: it should move 0.`
    );
  } else if (result.statements.length > 0) {
    lines.push("Nothing written. Run again with --apply.");
  }
  if (unreadable) {
    lines.push(
      "Some values open under neither key. They need the key they were written under, or the person who set them has to enter them again."
    );
  }
  return { exitCode: unreadable ? 1 : 0, report: lines.join("\n") };
};
