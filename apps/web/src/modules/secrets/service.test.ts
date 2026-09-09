import { Database, type SQLQueryBindings } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "#/db/client";

/**
 * The service layer, against the shipped migrations in an in-memory database.
 *
 * What is actually load-bearing here: the value goes in and never comes back
 * out except through the two resolve functions, a ciphertext is bound to its
 * own row, and every read is scoped to a workspace even when addressed by a
 * bare id.
 */

const { generateConnectorKey, decryptSecret } = await import("#/crypto");
const {
  agentHasSecrets,
  createSecret,
  deleteSecret,
  deleteSecretGrantsForAgent,
  deleteSecretsForWorkspace,
  getSecret,
  grantSecret,
  listAgentIdsForSecret,
  listSecrets,
  listSecretsForAgent,
  markSecretUsed,
  MissingSecretsKeyError,
  recordSecretSync,
  resetSecretMirrorForWorkspace,
  resolveSecretForAgent,
  resolveSecretForMirror,
  revokeSecret,
  toSecretView,
  updateSecret,
} = await import("./service");
const { workspaceSecrets } = await import("./schema");

const MIGRATIONS_DIR = new URL("../../../drizzle/", import.meta.url);

const createTestD1 = (): D1Database => {
  const journal = JSON.parse(
    readFileSync(new URL("meta/_journal.json", MIGRATIONS_DIR), "utf8")
  ) as { entries: { tag: string }[] };

  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  for (const entry of journal.entries) {
    const sql = readFileSync(
      new URL(`${entry.tag}.sql`, MIGRATIONS_DIR),
      "utf8"
    );
    for (const statement of sql.split("--> statement-breakpoint")) {
      sqlite.exec(statement);
    }
  }

  return {
    batch: (statements: { all: () => Promise<unknown> }[]) =>
      Promise.all(statements.map((statement) => statement.all())),
    prepare: (query: string) => {
      const stmt = sqlite.query(query);
      return {
        bind: (...params: SQLQueryBindings[]) => ({
          all: () => Promise.resolve({ results: stmt.all(...params) }),
          raw: () => Promise.resolve(stmt.values(...params)),
          run: () => Promise.resolve(stmt.run(...params)),
        }),
      };
    },
  } as unknown as D1Database;
};

const ALPHA = "ws_alpha";
const BETA = "ws_beta";
const ADA = "user_2aAdaAAAAAAAAAAAAAAAAAAA";
const AGENT = "agent_1";
const OTHER_AGENT = "agent_2";
const VALUE = "dg-0123456789abcdef";

let db: Db;
let env: Env;

/** Reaching under the service to plant a row the service would never write. */
const eqId = (id: string) => eq(workspaceSecrets.id, id);

const newSecret = (
  workspaceId = ALPHA,
  overrides: Partial<Parameters<typeof createSecret>[3]> = {}
) =>
  createSecret(db, env, workspaceId, {
    allowedHosts: ["api.deepgram.com"],
    clerkUserId: ADA,
    name: "DEEPGRAM_API_KEY",
    value: VALUE,
    ...overrides,
  });

beforeEach(() => {
  const d1 = createTestD1();
  db = createDb(d1);
  env = { CONNECTOR_KEY: generateConnectorKey(), DB: d1 } as unknown as Env;
});

describe("createSecret", () => {
  test("stores the value encrypted, and hints at its last four characters", async () => {
    const secret = await newSecret();

    expect(secret.hint).toBe(VALUE.slice(-4));
    expect(secret.valueEnc).not.toContain(VALUE);
    expect(secret.keyVersion).toBe(1);
    expect(secret.syncStatus).toBe("unregistered");
    expect(secret.vaultCredentialId).toBeNull();
    expect(secret.lastUsedAt).toBeNull();
  });

  test("defaults the header to a bearer token, prefix trailing space intact", async () => {
    const secret = await newSecret();
    expect(secret.header).toBe("Authorization");
    // The trailing space is the whole point: `Bearer` + value would be wrong.
    expect(secret.headerPrefix).toBe("Bearer ");
  });

  test("keeps an explicit prefix verbatim, including an empty one", async () => {
    const deepgram = await newSecret(ALPHA, { headerPrefix: "Token " });
    expect(deepgram.headerPrefix).toBe("Token ");

    const apiKey = await newSecret(ALPHA, {
      header: "x-api-key",
      headerPrefix: "",
      name: "OTHER_KEY",
    });
    expect(apiKey.headerPrefix).toBe("");
    expect(apiKey.header).toBe("x-api-key");
  });

  test("the same name in two workspaces is two secrets", async () => {
    await newSecret(ALPHA);
    await newSecret(BETA);
    expect(await listSecrets(db, ALPHA)).toHaveLength(1);
    expect(await listSecrets(db, BETA)).toHaveLength(1);
  });

  test("the same name twice in one workspace is a constraint failure", async () => {
    await newSecret(ALPHA);
    expect(newSecret(ALPHA)).rejects.toThrow();
  });

  test("refuses to store anything without a CONNECTOR_KEY", () => {
    const keyless = { DB: env.DB } as unknown as Env;
    expect(
      createSecret(db, keyless, ALPHA, {
        allowedHosts: ["api.deepgram.com"],
        clerkUserId: ADA,
        name: "DEEPGRAM_API_KEY",
        value: VALUE,
      })
    ).rejects.toThrow(MissingSecretsKeyError);
  });
});

describe("the ciphertext is bound to its row", () => {
  test("a value moved into another secret's row does not decrypt", async () => {
    const mine = await newSecret(ALPHA);
    const other = await newSecret(ALPHA, { name: "OTHER_KEY" });

    // The copy an attacker with write access to D1 would make.
    await db
      .update(workspaceSecrets)
      .set({ valueEnc: mine.valueEnc })
      .where(eqId(other.id));

    expect(resolveSecretForMirror(db, env, ALPHA, other.id)).rejects.toThrow();
    // And the row it belongs to still works.
    const ok = await resolveSecretForMirror(db, env, ALPHA, mine.id);
    expect(ok?.value).toBe(VALUE);
  });

  test("a value moved into another tenant's row does not decrypt", async () => {
    const mine = await newSecret(ALPHA);
    const theirs = await newSecret(BETA);

    await db
      .update(workspaceSecrets)
      .set({ valueEnc: mine.valueEnc })
      .where(eqId(theirs.id));

    expect(resolveSecretForMirror(db, env, BETA, theirs.id)).rejects.toThrow();
  });

  test("the stored ciphertext is not readable without the row's own binding", async () => {
    const secret = await newSecret(ALPHA);
    // No AAD at all - the shape every pre-secrets caller uses.
    expect(
      decryptSecret(env.CONNECTOR_KEY ?? "", secret.valueEnc)
    ).rejects.toThrow();
  });
});

describe("views never carry the value", () => {
  test("neither the value nor the ciphertext nor the Clerk id is serialized", async () => {
    const secret = await newSecret();
    await grantSecret(db, secret.id, AGENT);

    const [view] = await listSecrets(db, ALPHA);
    const serialized = JSON.stringify(view);

    expect(serialized).not.toContain(VALUE);
    expect(serialized).not.toContain(secret.valueEnc);
    expect(serialized).not.toContain(ADA);
    expect(view?.hint).toBe(VALUE.slice(-4));
    expect(view?.agentIds).toEqual([AGENT]);
  });

  test("a view built without grants says so rather than guessing", async () => {
    const secret = await newSecret();
    expect(toSecretView(secret).agentIds).toEqual([]);
  });
});

describe("updateSecret", () => {
  test("a new value re-encrypts under the same binding and moves the hint", async () => {
    const secret = await newSecret();
    const rotated = await updateSecret(db, env, ALPHA, secret.id, {
      value: "dg-fedcba9876543210",
    });

    expect(rotated?.hint).toBe("3210");
    expect(rotated?.valueEnc).not.toBe(secret.valueEnc);
    const resolved = await resolveSecretForMirror(db, env, ALPHA, secret.id);
    expect(resolved?.value).toBe("dg-fedcba9876543210");
  });

  test("edits the metadata without touching the value", async () => {
    const secret = await newSecret();
    const updated = await updateSecret(db, env, ALPHA, secret.id, {
      allowedHosts: ["*.deepgram.com"],
      description: "Transcription",
      header: "x-api-key",
      headerPrefix: "",
    });

    expect(updated?.allowedHosts).toEqual(["*.deepgram.com"]);
    expect(updated?.description).toBe("Transcription");
    expect(updated?.headerPrefix).toBe("");
    expect(updated?.valueEnc).toBe(secret.valueEnc);
    expect(updated?.hint).toBe(secret.hint);
  });

  test("moves updatedAt, since the column default only fires on insert", async () => {
    const secret = await newSecret();
    const updated = await updateSecret(db, env, ALPHA, secret.id, {
      description: "Changed",
    });
    expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(
      secret.updatedAt.getTime()
    );
  });

  test("leaves the mirror's own columns to the mirror", async () => {
    const secret = await newSecret();
    await recordSecretSync(db, secret.id, {
      status: "synced",
      vaultCredentialId: "cred_1",
    });

    const updated = await updateSecret(db, env, ALPHA, secret.id, {
      description: "Changed",
    });
    // A save must not silently claim the mirror is stale; the background push
    // it kicks off is what moves this.
    expect(updated?.syncStatus).toBe("synced");
    expect(updated?.vaultCredentialId).toBe("cred_1");
  });

  test("will not reach another workspace's row by bare id", async () => {
    const theirs = await newSecret(BETA);
    expect(
      await updateSecret(db, env, ALPHA, theirs.id, { description: "Stolen" })
    ).toBeUndefined();
    expect((await getSecret(db, BETA, theirs.id))?.description).toBe("");
  });
});

describe("deleteSecret", () => {
  test("takes its grants with it", async () => {
    const secret = await newSecret();
    await grantSecret(db, secret.id, AGENT);
    await grantSecret(db, secret.id, OTHER_AGENT);

    expect(await deleteSecret(db, ALPHA, secret.id)).toBe(true);
    expect(await getSecret(db, ALPHA, secret.id)).toBeUndefined();
    expect(await listAgentIdsForSecret(db, secret.id)).toEqual([]);
  });

  test("will not delete another workspace's row by bare id", async () => {
    const theirs = await newSecret(BETA);
    expect(await deleteSecret(db, ALPHA, theirs.id)).toBe(false);
    expect(await getSecret(db, BETA, theirs.id)).toBeDefined();
  });
});

describe("grants", () => {
  test("granting twice is one row, and says nothing changed the second time", async () => {
    const secret = await newSecret();
    expect(await grantSecret(db, secret.id, AGENT)).toBe(true);
    expect(await grantSecret(db, secret.id, AGENT)).toBe(false);
    expect(await listAgentIdsForSecret(db, secret.id)).toEqual([AGENT]);
  });

  test("revoking reports whether there was anything to revoke", async () => {
    const secret = await newSecret();
    await grantSecret(db, secret.id, AGENT);
    expect(await revokeSecret(db, secret.id, AGENT)).toBe(true);
    expect(await revokeSecret(db, secret.id, AGENT)).toBe(false);
  });

  test("what an agent is told carries no hint and no id", async () => {
    const secret = await newSecret(ALPHA, { description: "Transcription" });
    await grantSecret(db, secret.id, AGENT);

    const listed = await listSecretsForAgent(db, ALPHA, AGENT);
    expect(listed).toEqual([
      {
        allowedHosts: ["api.deepgram.com"],
        description: "Transcription",
        name: "DEEPGRAM_API_KEY",
      },
    ]);
    expect(JSON.stringify(listed)).not.toContain(secret.hint);
    expect(JSON.stringify(listed)).not.toContain(secret.id);
  });

  test("a grant is not visible from another workspace's scope", async () => {
    const theirs = await newSecret(BETA);
    await grantSecret(db, theirs.id, AGENT);

    expect(await listSecretsForAgent(db, ALPHA, AGENT)).toEqual([]);
    expect(await agentHasSecrets(db, ALPHA, AGENT)).toBe(false);
    expect(await agentHasSecrets(db, BETA, AGENT)).toBe(true);
  });
});

describe("resolveSecretForAgent - the tool path", () => {
  test("returns the value and everything needed to inject it", async () => {
    const secret = await newSecret(ALPHA, { headerPrefix: "Token " });
    await grantSecret(db, secret.id, AGENT);

    const resolved = await resolveSecretForAgent(db, env, {
      agentId: AGENT,
      name: "DEEPGRAM_API_KEY",
      workspaceId: ALPHA,
    });

    expect(resolved).toEqual({
      allowedHosts: ["api.deepgram.com"],
      header: "Authorization",
      headerPrefix: "Token ",
      id: secret.id,
      name: "DEEPGRAM_API_KEY",
      value: VALUE,
    });
  });

  /**
   * The three misses are one answer on purpose: a distinguishable "exists but
   * not yours" tells an agent which secret names are real.
   */
  test.each([
    ["a name that does not exist", "NOPE_KEY", ALPHA, AGENT],
    ["a secret it was not granted", "DEEPGRAM_API_KEY", ALPHA, OTHER_AGENT],
    ["a secret of another workspace", "DEEPGRAM_API_KEY", BETA, AGENT],
  ])("%s resolves to null", async (_label, name, workspaceId, agentId) => {
    const secret = await newSecret(ALPHA);
    await grantSecret(db, secret.id, AGENT);

    expect(
      await resolveSecretForAgent(db, env, { agentId, name, workspaceId })
    ).toBeNull();
  });

  test("a grant made through another workspace's secret does not resolve here", async () => {
    // Both workspaces have a secret of the same name; only Beta's is granted.
    await newSecret(ALPHA);
    const theirs = await newSecret(BETA);
    await grantSecret(db, theirs.id, AGENT);

    expect(
      await resolveSecretForAgent(db, env, {
        agentId: AGENT,
        name: "DEEPGRAM_API_KEY",
        workspaceId: ALPHA,
      })
    ).toBeNull();
  });
});

describe("markSecretUsed", () => {
  test("bumps lastUsedAt and leaves updatedAt alone", async () => {
    const secret = await newSecret();
    const usedAt = new Date(secret.updatedAt.getTime() + 60_000);
    await markSecretUsed(db, secret.id, usedAt);

    const after = await getSecret(db, ALPHA, secret.id);
    expect(after?.lastUsedAt?.getTime()).toBe(usedAt.getTime());
    // The tool touching a secret is not somebody editing it.
    expect(after?.updatedAt.getTime()).toBe(secret.updatedAt.getTime());
  });
});

describe("the mirror's own columns", () => {
  test("records a failure without disturbing the value or updatedAt", async () => {
    const secret = await newSecret();
    await recordSecretSync(db, secret.id, {
      error: "A vault holds at most 20 credentials.",
      status: "error",
    });

    const after = await getSecret(db, ALPHA, secret.id);
    expect(after?.syncStatus).toBe("error");
    expect(after?.syncError).toContain("20");
    expect(after?.valueEnc).toBe(secret.valueEnc);
    expect(after?.updatedAt.getTime()).toBe(secret.updatedAt.getTime());
  });

  test("a success clears the previous error", async () => {
    const secret = await newSecret();
    await recordSecretSync(db, secret.id, { error: "boom", status: "error" });
    await recordSecretSync(db, secret.id, {
      status: "synced",
      vaultCredentialId: "cred_1",
    });

    const after = await getSecret(db, ALPHA, secret.id);
    expect(after?.syncError).toBeNull();
    expect(after?.vaultCredentialId).toBe("cred_1");
  });

  test("a key change forgets the vault ids and leaves the values", async () => {
    const secret = await newSecret();
    await recordSecretSync(db, secret.id, {
      status: "synced",
      vaultCredentialId: "cred_1",
    });

    await resetSecretMirrorForWorkspace(db, ALPHA);

    const after = await getSecret(db, ALPHA, secret.id);
    expect(after?.vaultCredentialId).toBeNull();
    expect(after?.syncStatus).toBe("unregistered");
    expect(after?.syncError).toBeNull();
    // Only the mirror is rebuilt; the secret itself is untouched.
    expect(after?.valueEnc).toBe(secret.valueEnc);
  });

  test("the reset is scoped to its workspace", async () => {
    const theirs = await newSecret(BETA);
    await recordSecretSync(db, theirs.id, {
      status: "synced",
      vaultCredentialId: "cred_beta",
    });

    await resetSecretMirrorForWorkspace(db, ALPHA);
    expect((await getSecret(db, BETA, theirs.id))?.vaultCredentialId).toBe(
      "cred_beta"
    );
  });
});

describe("cleanup", () => {
  test("deleting a workspace takes its secrets and every grant naming one", async () => {
    const mine = await newSecret(ALPHA);
    const theirs = await newSecret(BETA);
    await grantSecret(db, mine.id, AGENT);
    await grantSecret(db, theirs.id, OTHER_AGENT);

    await deleteSecretsForWorkspace(db, ALPHA);

    expect(await listSecrets(db, ALPHA)).toEqual([]);
    expect(await listAgentIdsForSecret(db, mine.id)).toEqual([]);
    // And the other workspace is untouched.
    expect(await listSecrets(db, BETA)).toHaveLength(1);
    expect(await listAgentIdsForSecret(db, theirs.id)).toEqual([OTHER_AGENT]);
  });

  test("deleting an agent takes its grants and leaves the secrets", async () => {
    const secret = await newSecret();
    await grantSecret(db, secret.id, AGENT);
    await grantSecret(db, secret.id, OTHER_AGENT);

    await deleteSecretGrantsForAgent(db, AGENT);

    expect(await listAgentIdsForSecret(db, secret.id)).toEqual([OTHER_AGENT]);
    expect(await getSecret(db, ALPHA, secret.id)).toBeDefined();
  });
});
