/// <reference types="bun" />
import { beforeEach, describe, expect, test } from "bun:test";
import { migrated } from "@repo/db/test-db";
import {
  decryptSecret,
  encryptSecret,
  importSecretsKey,
  keySpec,
  type SecretBinding,
} from "@repo/services/crypto";
import {
  type Driver,
  plan,
  type Row,
  run,
  TARGETS,
} from "./rotate-secrets-key-helpers.ts";

const b64 = (fill: number) =>
  Buffer.from(new Uint8Array(32).fill(fill)).toString("base64");
const OLD = b64(1);
const NEW = b64(2);
const KEYS = { current: NEW, previous: OLD };
const WS = "ws_1";
const PLAINTEXT = "sk-not-a-real-secret";

let db: ReturnType<typeof migrated>;

/** Inserts a row, filling the NOT NULL columns the test does not care about. */
const insert = (table: string, values: Record<string, string | number>) => {
  const columns = db.client.query(`PRAGMA table_info("${table}")`).all() as {
    dflt_value: unknown;
    name: string;
    notnull: number;
  }[];
  const row: Record<string, string | number> = { ...values };
  for (const column of columns) {
    if (!(column.name in row) && column.notnull && column.dflt_value === null) {
      row[column.name] = "x";
    }
  }
  const names = Object.keys(row);
  db.client
    .query(
      `INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`
    )
    .run(...Object.values(row));
};

const driver = (): Driver => ({
  exec: (statements) => {
    for (const statement of statements) {
      db.client.run(statement);
    }
    return Promise.resolve();
  },
  select: (sql) => Promise.resolve(db.client.query(sql).all() as Row[]),
});

const sealWith = async (
  spec: string,
  binding: SecretBinding,
  value = PLAINTEXT
) => await encryptSecret(await importSecretsKey(spec), binding, value);

const bind = (table: string, rowId: string, field: string): SecretBinding => ({
  field,
  rowId,
  table,
  workspaceId: WS,
});

/** The `v` column of the first row. */
const read = (sql: string): string =>
  (db.client.query(sql).get() as { v: string }).v;

/** Reads `stored` with the new key alone. */
const readsWithNewOnly = async (binding: SecretBinding, stored: string) =>
  await decryptSecret(await importSecretsKey(NEW), binding, stored);

beforeEach(() => {
  db = migrated();
  db.client.run("PRAGMA foreign_keys = OFF");
});

describe("rotate-secrets-key", () => {
  test("moves a secret written under the old key, then it reads with the new key alone", async () => {
    const binding = bind("secrets", "sec_1", "value");
    insert("secrets", {
      id: "sec_1",
      value_enc: await sealWith(OLD, binding),
      workspace_id: WS,
    });
    const before = read("SELECT value_enc AS v FROM secrets");
    const result = await run(driver(), KEYS, true);
    expect(result.exitCode).toBe(0);
    const after = read("SELECT value_enc AS v FROM secrets");
    expect(after).not.toBe(before);
    expect(await readsWithNewOnly(binding, after)).toBe(PLAINTEXT);
    // Under the pair, as the Worker holds it during the rotation.
    const pair = await importSecretsKey(keySpec(NEW, OLD));
    expect(await decryptSecret(pair, binding, after)).toBe(PLAINTEXT);
  });

  test("a dry run changes nothing", async () => {
    const binding = bind("secrets", "sec_1", "value");
    const stored = await sealWith(OLD, binding);
    insert("secrets", { id: "sec_1", value_enc: stored, workspace_id: WS });
    const result = await run(driver(), KEYS, false);
    expect(result.report).toContain("secrets.value_enc: 1 to move");
    expect(read("SELECT value_enc AS v FROM secrets")).toBe(stored);
  });

  test("a second run moves nothing", async () => {
    insert("secrets", {
      id: "sec_1",
      value_enc: await sealWith(OLD, bind("secrets", "sec_1", "value")),
      workspace_id: WS,
    });
    await run(driver(), KEYS, true);
    const again = await plan(driver(), KEYS);
    expect(again.statements).toEqual([]);
    expect(again.tallies.get("secrets.value_enc")).toEqual({
      current: 1,
      moved: 0,
      unreadable: [],
    });
  });

  test("leaves a value that is already under the current key alone", async () => {
    const binding = bind("secrets", "sec_1", "value");
    const stored = await sealWith(NEW, binding);
    insert("secrets", { id: "sec_1", value_enc: stored, workspace_id: WS });
    const result = await plan(driver(), KEYS);
    expect(result.statements).toEqual([]);
    expect(read("SELECT value_enc AS v FROM secrets")).toBe(stored);
  });

  test("reports a value neither key opens, leaves it, and exits 1", async () => {
    const stored = await sealWith(b64(9), bind("secrets", "sec_1", "value"));
    insert("secrets", { id: "sec_1", value_enc: stored, workspace_id: WS });
    const result = await run(driver(), KEYS, true);
    expect(result.exitCode).toBe(1);
    expect(result.report).toContain("1 unreadable (sec_1)");
    expect(result.report).not.toContain(stored);
    expect(read("SELECT value_enc AS v FROM secrets")).toBe(stored);
  });

  test("a row the app changed after the read is not overwritten", async () => {
    const binding = bind("secrets", "sec_1", "value");
    insert("secrets", {
      id: "sec_1",
      value_enc: await sealWith(OLD, binding),
      workspace_id: WS,
    });
    const planned = await plan(driver(), KEYS);
    const changed = await sealWith(NEW, binding, "changed by the app");
    db.client.run(`UPDATE secrets SET value_enc = '${changed}'`);
    await driver().exec(planned.statements);
    expect(read("SELECT value_enc AS v FROM secrets")).toBe(changed);
  });

  test("moves every encrypted column with its own binding", async () => {
    const signing = bind("slack_apps", "s1", "signing_secret");
    const cases: {
      binding: SecretBinding;
      /** The sealed text as the database holds it now. */
      stored: () => string;
      table: string;
      values: (sealed: string) => Record<string, string | number>;
    }[] = [];
    const column =
      (table: string, name: string, where = "1 = 1") =>
      () =>
        read(`SELECT "${name}" AS v FROM "${table}" WHERE ${where}`);
    const add = (
      table: string,
      name: string,
      binding: SecretBinding,
      extra: Record<string, string | number>,
      json?: (sealed: string) => string
    ) => {
      const where =
        table === "a2a_outbox" ? `id = '${binding.rowId}'` : "1 = 1";
      const stored = column(table, name, where);
      cases.push({
        binding,
        stored: json ? () => unwrap(stored()) : stored,
        table,
        values: (sealed) => ({
          ...extra,
          [name]: json ? json(sealed) : sealed,
        }),
      });
    };
    const unwrap = (text: string): string => {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const client = parsed.client as { clientSecret: string } | undefined;
      return client ? client.clientSecret : String(parsed.token);
    };
    add("credentials", "secret", bind("credentials", "c1", "secret"), {
      id: "c1",
      workspace_id: WS,
    });
    add(
      "workspace_anthropic_keys",
      "api_key_enc",
      bind("workspace_anthropic_keys", WS, "api_key"),
      { workspace_id: WS }
    );
    add(
      "workspace_model_keys",
      "api_key_enc",
      bind("workspace_model_keys", `${WS}:openai`, "api_key"),
      { provider: "openai", workspace_id: WS }
    );
    add("slack_apps", "bot_token", bind("slack_apps", "s1", "bot_token"), {
      id: "s1",
      signing_secret: await sealWith(OLD, signing),
      workspace_id: WS,
    });
    add(
      "a2a_connections",
      "outbound_credential",
      bind("a2a_connections", "a1", "outbound_credential"),
      { id: "a1", workspace_id: WS }
    );
    add("a2a_push_configs", "token", bind("a2a_push_configs", "p1", "token"), {
      id: "p1",
      workspace_id: WS,
    });
    add("a2a_outbox", "headers", bind("a2a_outbox", "o1", "headers"), {
      id: "o1",
      kind: "push",
      workspace_id: WS,
    });
    add(
      "artifact_shares",
      "token_encrypted",
      bind("artifact_shares", "sh1", "token"),
      { id: "sh1", token_hash: "h", workspace_id: WS }
    );
    add(
      "connectors",
      "oauth",
      bind("connectors", "k1", "oauth.clientSecret"),
      { id: "k1", workspace_id: WS },
      (sealed) =>
        JSON.stringify({ client: { clientId: "i", clientSecret: sealed } })
    );
    add(
      "a2a_outbox",
      "body",
      bind("a2a_outbox", "o2", "body.token"),
      { id: "o2", kind: "pair_activate", workspace_id: WS },
      (sealed) => JSON.stringify({ token: sealed })
    );

    const ciphertexts = await Promise.all(
      cases.map((c) => sealWith(OLD, c.binding))
    );
    for (const [index, c] of cases.entries()) {
      insert(c.table, c.values(ciphertexts[index] ?? ""));
    }
    const result = await run(driver(), KEYS, true);
    expect(result.exitCode).toBe(0);

    const opened = await Promise.all(
      cases.map((c) => readsWithNewOnly(c.binding, c.stored()))
    );
    expect(opened).toEqual(cases.map(() => PLAINTEXT));
    // The signing secret rode along on the slack row and moved too.
    expect(
      await readsWithNewOnly(
        signing,
        read("SELECT signing_secret AS v FROM slack_apps")
      )
    ).toBe(PLAINTEXT);
  });

  test("covers every table the services encrypt", () => {
    const labels = TARGETS.map((t) => `${t.table}.${t.column}`);
    expect(labels).toEqual([
      "secrets.value_enc",
      "credentials.secret",
      "workspace_anthropic_keys.api_key_enc",
      "workspace_model_keys.api_key_enc",
      "slack_apps.bot_token",
      "slack_apps.signing_secret",
      "a2a_connections.outbound_credential",
      "a2a_push_configs.authentication",
      "a2a_push_configs.token",
      "a2a_outbox.headers",
      "artifact_shares.token_encrypted",
      "connectors.oauth",
      "a2a_outbox.body",
    ]);
  });
});
