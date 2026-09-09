import { Database, type SQLQueryBindings } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { generateConnectorKey } from "#/crypto";
import { createDb, type Db } from "#/db/client";
import { appConfig, secretsVaultIdKeyFor } from "#/modules/anthropic/schema";
import {
  type ArchiveCredentialInput,
  type EnvVarCredentialInput,
  MAX_VAULT_CREDENTIALS,
  type SecretVaultGateway,
  type UpdateEnvVarCredentialInput,
} from "#/modules/anthropic/vaults";
import {
  deleteWorkspaceSecretVaultWith,
  removeSecretMirrorWith,
  syncSecretMirror,
  syncSecretMirrorWith,
  syncWorkspaceSecretMirrorsWith,
} from "./mirror";
import type { WorkspaceSecret } from "./schema";
import {
  createSecret,
  getSecret,
  recordSecretSync,
  resetSecretMirrorForWorkspace,
  updateSecret,
} from "./service";

/**
 * The vault mirror, against a fake gateway: no Anthropic client is ever
 * constructed, and no plaintext leaves the fake.
 *
 * What is load-bearing here: the mirror never throws into its caller, every
 * outcome lands on the row through `recordSecretSync`, the value never reaches
 * `sync_error`, and the workspace's one vault is created once and only once.
 */

const MIGRATIONS_DIR = new URL("../../../drizzle/", import.meta.url);

const createTestD1 = (): D1Database => {
  const journal = JSON.parse(
    readFileSync(new URL("meta/_journal.json", MIGRATIONS_DIR), "utf8")
  ) as { entries: { tag: string }[] };

  const sqlite = new Database(":memory:");
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
const ADA = "user_2aAdaAAAAAAAAAAAAAAAAAAA";
const VALUE = "dg-0123456789abcdef";
const HOSTS = ["api.deepgram.com"];

interface VaultCalls {
  archived: ArchiveCredentialInput[];
  created: EnvVarCredentialInput[];
  deletedVaults: string[];
  updated: UpdateEnvVarCredentialInput[];
  /** One entry per vault actually made, so "created once" is observable. */
  vaults: string[];
}

const fakeVaults = (
  options: { failCredentials?: Error } = {}
): { calls: VaultCalls; gateway: SecretVaultGateway } => {
  const calls: VaultCalls = {
    archived: [],
    created: [],
    deletedVaults: [],
    updated: [],
    vaults: [],
  };

  const gateway: SecretVaultGateway = {
    archiveCredential(input) {
      calls.archived.push(input);
      return Promise.resolve();
    },
    createEnvVarCredential(input) {
      if (options.failCredentials) {
        return Promise.reject(options.failCredentials);
      }
      calls.created.push(input);
      return Promise.resolve(`cred_${calls.created.length}`);
    },
    createSecretsVault(input) {
      calls.vaults.push(input.workspaceId);
      return Promise.resolve(`vault_secrets_${calls.vaults.length}`);
    },
    deleteVault(vaultId) {
      calls.deletedVaults.push(vaultId);
      return Promise.resolve();
    },
    updateEnvVarCredential(input) {
      if (options.failCredentials) {
        return Promise.reject(options.failCredentials);
      }
      calls.updated.push(input);
      return Promise.resolve();
    },
  };
  return { calls, gateway };
};

/**
 * A gateway that loses the race for the workspace's vault: the cache row appears
 * while its own create is in flight, which is exactly what a second push racing
 * the first one looks like from here.
 */
const fakeVaultsLosingTheRace = (
  winner: string
): { calls: VaultCalls; gateway: SecretVaultGateway } => {
  const beaten = fakeVaults();
  return {
    calls: beaten.calls,
    gateway: {
      ...beaten.gateway,
      async createSecretsVault(input) {
        const id = await beaten.gateway.createSecretsVault(input);
        await db
          .insert(appConfig)
          .values({ key: secretsVaultIdKeyFor(ALPHA), value: winner });
        return id;
      },
    },
  };
};

let db: Db;
let env: Env;

beforeEach(() => {
  const d1 = createTestD1();
  db = createDb(d1);
  env = { CONNECTOR_KEY: generateConnectorKey(), DB: d1 } as unknown as Env;
});

const newSecret = (name = "DEEPGRAM_API_KEY", value = VALUE) =>
  createSecret(db, env, ALPHA, {
    allowedHosts: HOSTS,
    clerkUserId: ADA,
    name,
    value,
  });

/** A workspace whose vault is already full, and the rows that filled it. */
const fillTheVault = async (): Promise<WorkspaceSecret[]> => {
  const filled: WorkspaceSecret[] = [];
  for (let index = 0; index < MAX_VAULT_CREDENTIALS; index += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: the rows are written in order
    const secret = await newSecret(`SECRET_${index}`, `value-${index}`);
    await recordSecretSync(db, secret.id, {
      status: "synced",
      vaultCredentialId: `cred_${index}`,
    });
    filled.push(secret);
  }
  return filled;
};

/** The cached vault id, which is the only thing that says a vault exists. */
const cachedVaultId = async (): Promise<string | undefined> => {
  const [row] = await db
    .select()
    .from(appConfig)
    .where(eq(appConfig.key, secretsVaultIdKeyFor(ALPHA)));
  return row?.value;
};

describe("syncSecretMirrorWith", () => {
  test("creates the workspace's vault and the credential, and records both", async () => {
    const secret = await newSecret();
    const { calls, gateway } = fakeVaults();

    await syncSecretMirrorWith(db, env, gateway, ALPHA, secret.id);

    expect(calls.vaults).toEqual([ALPHA]);
    expect(calls.created).toEqual([
      {
        allowedHosts: HOSTS,
        displayName: "DEEPGRAM_API_KEY",
        secretId: secret.id,
        secretName: "DEEPGRAM_API_KEY",
        value: VALUE,
        vaultId: "vault_secrets_1",
      },
    ]);

    const stored = await getSecret(db, ALPHA, secret.id);
    expect(stored?.syncStatus).toBe("synced");
    expect(stored?.syncError).toBeNull();
    expect(stored?.vaultCredentialId).toBe("cred_1");
    expect(await cachedVaultId()).toBe("vault_secrets_1");
  });

  test("a second secret joins the same vault", async () => {
    const first = await newSecret("DEEPGRAM_API_KEY");
    const second = await newSecret("OPENAI_API_KEY", "sk-second-value");
    const { calls, gateway } = fakeVaults();

    await syncSecretMirrorWith(db, env, gateway, ALPHA, first.id);
    await syncSecretMirrorWith(db, env, gateway, ALPHA, second.id);

    expect(calls.vaults).toEqual([ALPHA]);
    expect(calls.created.map((call) => call.vaultId)).toEqual([
      "vault_secrets_1",
      "vault_secrets_1",
    ]);
  });

  test("updates the credential the row already names, with the whole host list", async () => {
    const secret = await newSecret();
    const { calls, gateway } = fakeVaults();
    await syncSecretMirrorWith(db, env, gateway, ALPHA, secret.id);

    const hosts = ["api.deepgram.com", "*.deepgram.com"];
    await updateSecret(db, env, ALPHA, secret.id, {
      allowedHosts: hosts,
      value: "dg-rotated-value",
    });
    await syncSecretMirrorWith(db, env, gateway, ALPHA, secret.id);

    expect(calls.created).toHaveLength(1);
    expect(calls.updated).toEqual([
      {
        allowedHosts: hosts,
        credentialId: "cred_1",
        value: "dg-rotated-value",
        vaultId: "vault_secrets_1",
      },
    ]);
    expect((await getSecret(db, ALPHA, secret.id))?.syncStatus).toBe("synced");
  });

  test("records the cap on the secret that would be the twenty-first", async () => {
    await fillTheVault();
    const overflow = await newSecret("ONE_TOO_MANY", "value-overflow");
    const { calls, gateway } = fakeVaults();

    await syncSecretMirrorWith(db, env, gateway, ALPHA, overflow.id);

    expect(calls.created).toEqual([]);
    expect(calls.vaults).toEqual([]);
    const stored = await getSecret(db, ALPHA, overflow.id);
    expect(stored?.syncStatus).toBe("error");
    expect(stored?.syncError).toContain(String(MAX_VAULT_CREDENTIALS));
    expect(stored?.syncError).toContain("http_request");
    expect(stored?.vaultCredentialId).toBeNull();
  });

  test("a secret already in the vault still rotates when the vault is full", async () => {
    const [first] = await fillTheVault();
    const { calls, gateway } = fakeVaults();

    await syncSecretMirrorWith(db, env, gateway, ALPHA, first?.id ?? "");

    expect(calls.updated.map((call) => call.credentialId)).toEqual(["cred_0"]);
  });

  test("records a failure without the value in it", async () => {
    const secret = await newSecret();
    const { gateway } = fakeVaults({
      failCredentials: new Error(
        `400 invalid request: {"secret_value":"${VALUE}"}`
      ),
    });

    await syncSecretMirrorWith(db, env, gateway, ALPHA, secret.id);

    const stored = await getSecret(db, ALPHA, secret.id);
    expect(stored?.syncStatus).toBe("error");
    expect(stored?.syncError).toContain("400 invalid request");
    expect(stored?.syncError).not.toContain(VALUE);
    expect(stored?.syncError).toContain("[REDACTED]");
    expect(stored?.vaultCredentialId).toBeNull();
  });

  test("does nothing for a secret that was deleted while the push waited", async () => {
    const { calls, gateway } = fakeVaults();

    await syncSecretMirrorWith(db, env, gateway, ALPHA, "secret_gone");

    expect(calls.created).toEqual([]);
    expect(calls.vaults).toEqual([]);
  });
});

describe("syncSecretMirror", () => {
  test("mirrors nothing, and records nothing, without an Anthropic key", async () => {
    const secret = await newSecret();

    await syncSecretMirror(db, env, ALPHA, secret.id);

    const stored = await getSecret(db, ALPHA, secret.id);
    expect(stored?.syncStatus).toBe("unregistered");
    expect(stored?.syncError).toBeNull();
    expect(await cachedVaultId()).toBeUndefined();
  });
});

describe("removeSecretMirrorWith", () => {
  test("archives the credential the row names", async () => {
    const secret = await newSecret();
    const { calls, gateway } = fakeVaults();
    await syncSecretMirrorWith(db, env, gateway, ALPHA, secret.id);
    const mirrored = await getSecret(db, ALPHA, secret.id);

    await removeSecretMirrorWith(db, gateway, {
      ...secret,
      vaultCredentialId: mirrored?.vaultCredentialId ?? null,
    });

    expect(calls.archived).toEqual([
      { credentialId: "cred_1", vaultId: "vault_secrets_1" },
    ]);
  });

  test("does nothing for a secret that was never mirrored", async () => {
    const secret = await newSecret();
    const { calls, gateway } = fakeVaults();

    await removeSecretMirrorWith(db, gateway, secret);

    expect(calls.archived).toEqual([]);
  });
});

describe("deleteWorkspaceSecretVaultWith", () => {
  test("deletes the vault and forgets its id", async () => {
    const secret = await newSecret();
    const { calls, gateway } = fakeVaults();
    await syncSecretMirrorWith(db, env, gateway, ALPHA, secret.id);

    await deleteWorkspaceSecretVaultWith(db, gateway, ALPHA);

    expect(calls.deletedVaults).toEqual(["vault_secrets_1"]);
    expect(await cachedVaultId()).toBeUndefined();
  });

  test("is a no-op for a workspace that never had a vault", async () => {
    const { calls, gateway } = fakeVaults();

    await deleteWorkspaceSecretVaultWith(db, gateway, ALPHA);

    expect(calls.deletedVaults).toEqual([]);
  });
});

describe("syncWorkspaceSecretMirrorsWith", () => {
  test("pushes every secret of the workspace into one vault", async () => {
    await newSecret("DEEPGRAM_API_KEY");
    await newSecret("OPENAI_API_KEY", "sk-second-value");
    await newSecret("STRIPE_API_KEY", "sk-third-value");
    const { calls, gateway } = fakeVaults();

    await syncWorkspaceSecretMirrorsWith(db, env, gateway, ALPHA);

    expect(calls.vaults).toEqual([ALPHA]);
    expect(calls.created.map((call) => call.secretName)).toEqual([
      "DEEPGRAM_API_KEY",
      "OPENAI_API_KEY",
      "STRIPE_API_KEY",
    ]);
  });

  test("is what brings the mirror back after a key change", async () => {
    const secret = await newSecret();
    await syncSecretMirrorWith(db, env, fakeVaults().gateway, ALPHA, secret.id);
    // What `resetWorkspaceAnthropicResources` leaves behind: the row remembers
    // nothing, and the vault it named belonged to the old key.
    await resetSecretMirrorForWorkspace(db, ALPHA);
    await db
      .delete(appConfig)
      .where(eq(appConfig.key, secretsVaultIdKeyFor(ALPHA)));
    const { calls, gateway } = fakeVaults();

    await syncWorkspaceSecretMirrorsWith(db, env, gateway, ALPHA);

    expect(calls.vaults).toEqual([ALPHA]);
    const stored = await getSecret(db, ALPHA, secret.id);
    expect(stored?.syncStatus).toBe("synced");
    expect(stored?.vaultCredentialId).toBe("cred_1");
  });
});

describe("two pushes racing the first vault", () => {
  test("the loser adopts the winning vault and deletes its own", async () => {
    const secret = await newSecret();
    const { calls, gateway } = fakeVaultsLosingTheRace("vault_winner");

    await syncSecretMirrorWith(db, env, gateway, ALPHA, secret.id);

    // The credential must land in the vault the cache names - the one a session
    // will actually be given - and the vault nobody points at must not be left
    // behind.
    expect(calls.created.map((call) => call.vaultId)).toEqual(["vault_winner"]);
    expect(calls.deletedVaults).toEqual(["vault_secrets_1"]);
    expect(await cachedVaultId()).toBe("vault_winner");
    expect((await getSecret(db, ALPHA, secret.id))?.vaultCredentialId).toBe(
      "cred_1"
    );
  });
});
