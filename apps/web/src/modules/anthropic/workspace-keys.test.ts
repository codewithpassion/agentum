import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { generateConnectorKey } from "#/crypto";
import type { Db } from "#/db/client";
import { agents } from "#/modules/agents/schema";
import { createAgent, setAgentRegistration } from "#/modules/agents/service";
import { connectors } from "#/modules/connectors/schema";
import { skills, skillVersions } from "#/modules/skills/schema";
import {
  appConfig,
  ENVIRONMENT_ID_KEY,
  environmentIdKeyFor,
  workspaceAnthropicKeys,
} from "./schema";
import {
  deleteWorkspaceAnthropicKey,
  getWorkspaceAnthropicKeyStatus,
  isAnthropicKeyShaped,
  MissingConnectorKeyError,
  resetWorkspaceAnthropicResources,
  resolveAnthropicKey,
  setWorkspaceAnthropicKey,
} from "./workspace-keys";

/**
 * The workspace key store, against the shipped migrations in an in-memory
 * database - the same combination the rest of this module tests with. Nothing
 * here constructs an Anthropic client: the live validation call belongs to the
 * route, and is faked there.
 */

// `workspaces/service` reaches the workspace-delete sweep, and through it the
// Durable Object classes, so the runtime module has to be stubbed before it is
// loaded - which is what makes the dynamic import below dynamic.
mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));

const { createWorkspace, DEFAULT_WORKSPACE_ID } = await import(
  "#/modules/workspaces/service"
);

const WORKSPACE_KEY = "sk-ant-api03-workspace-secret-cD3f";
const GLOBAL_KEY = "sk-ant-api03-deployment-wide-key";

const migrate = (): Db => {
  const dir = new URL("../../../drizzle/", import.meta.url);
  const journal = JSON.parse(
    readFileSync(new URL("meta/_journal.json", dir), "utf8")
  ) as { entries: { tag: string }[] };

  const sqlite = new Database(":memory:");
  for (const entry of journal.entries) {
    const sql = readFileSync(new URL(`${entry.tag}.sql`, dir), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      sqlite.run(statement);
    }
  }
  return drizzle(sqlite) as unknown as Db;
};

let db: Db;
let env: Env;

beforeEach(() => {
  db = migrate();
  env = {
    ANTHROPIC_API_KEY: GLOBAL_KEY,
    CONNECTOR_KEY: generateConnectorKey(),
  } as unknown as Env;
});

const store = (workspaceId = DEFAULT_WORKSPACE_ID, apiKey = WORKSPACE_KEY) =>
  setWorkspaceAnthropicKey(db, env, {
    apiKey,
    clerkUserId: "user_2aOwnerAAAAAAAAAAAAAAAAAA",
    workspaceId,
  });

const rowFor = async (workspaceId: string) => {
  const [row] = await db
    .select()
    .from(workspaceAnthropicKeys)
    .where(eq(workspaceAnthropicKeys.workspaceId, workspaceId));
  return row;
};

describe("isAnthropicKeyShaped", () => {
  test("accepts an Anthropic key and rejects anything else", () => {
    expect(isAnthropicKeyShaped(WORKSPACE_KEY)).toBe(true);
    expect(isAnthropicKeyShaped("sk-proj-openai-looking-key")).toBe(false);
    expect(isAnthropicKeyShaped(`sk-ant-${"x".repeat(600)}`)).toBe(false);
  });
});

describe("setWorkspaceAnthropicKey", () => {
  test("stores the key encrypted, never in plaintext", async () => {
    await store();

    const row = await rowFor(DEFAULT_WORKSPACE_ID);
    expect(row?.apiKeyEnc).toBeString();
    expect(row?.apiKeyEnc).not.toContain(WORKSPACE_KEY);
    // The whole row, so a future column cannot smuggle the key out either.
    expect(JSON.stringify(row)).not.toContain(WORKSPACE_KEY);
  });

  test("keeps only the last four characters as the hint", async () => {
    const status = await store();

    expect(status).toEqual({
      configured: true,
      hint: "cD3f",
      setAt: expect.any(Date),
    });
    expect(WORKSPACE_KEY).toEndWith(status.hint ?? "");
  });

  test("never hands the key back, or who set it", async () => {
    await store();

    const status = await getWorkspaceAnthropicKeyStatus(
      db,
      DEFAULT_WORKSPACE_ID
    );
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(WORKSPACE_KEY);
    expect(serialized).not.toContain("user_2aOwner");
  });

  test("rotates in place, moving the hint and the date", async () => {
    const first = await store();
    const before = (await rowFor(DEFAULT_WORKSPACE_ID))?.apiKeyEnc;

    const rotated = await store(
      DEFAULT_WORKSPACE_ID,
      "sk-ant-api03-second-9xYz"
    );

    const rows = await db.select().from(workspaceAnthropicKeys);
    expect(rows).toHaveLength(1);
    expect(rotated.hint).toBe("9xYz");
    expect(rows[0]?.apiKeyEnc).not.toBe(before);
    expect(rotated.setAt?.getTime()).toBeGreaterThanOrEqual(
      first.setAt?.getTime() ?? 0
    );
  });

  test("refuses when there is no CONNECTOR_KEY to encrypt with", async () => {
    env = { ...env, CONNECTOR_KEY: "" } as unknown as Env;

    await expect(store()).rejects.toThrow(MissingConnectorKeyError);
    expect(await db.select().from(workspaceAnthropicKeys)).toHaveLength(0);
  });
});

describe("getWorkspaceAnthropicKeyStatus", () => {
  test("says so when the workspace has no key of its own", async () => {
    expect(
      await getWorkspaceAnthropicKeyStatus(db, DEFAULT_WORKSPACE_ID)
    ).toEqual({ configured: false, hint: null, setAt: null });
  });
});

describe("resolveAnthropicKey", () => {
  test("falls back to the deployment-global key", async () => {
    expect(await resolveAnthropicKey(db, env, DEFAULT_WORKSPACE_ID)).toEqual({
      apiKey: GLOBAL_KEY,
      source: "global",
    });
  });

  test("decrypts the workspace's own key when it has one", async () => {
    await store();

    expect(await resolveAnthropicKey(db, env, DEFAULT_WORKSPACE_ID)).toEqual({
      apiKey: WORKSPACE_KEY,
      source: "workspace",
    });
  });

  test("resolves per workspace, not per deployment", async () => {
    const { workspace } = await createWorkspace(db, {
      name: "Globex",
      owner: {
        clerkUserId: "user_2cOutsiderCCCCCCCCCCCC",
        email: "alan@example.com",
        imageUrl: "",
        name: "Alan Turing",
      },
    });
    await store();

    expect((await resolveAnthropicKey(db, env, workspace.id))?.source).toBe(
      "global"
    );
    expect(
      (await resolveAnthropicKey(db, env, DEFAULT_WORKSPACE_ID))?.source
    ).toBe("workspace");
  });

  test("is null when neither the workspace nor the deployment has a key", async () => {
    env = { ...env, ANTHROPIC_API_KEY: "" } as unknown as Env;

    expect(await resolveAnthropicKey(db, env, DEFAULT_WORKSPACE_ID)).toBe(null);
  });

  test("throws rather than billing the deployment's key by accident", async () => {
    await store();
    env = { ...env, CONNECTOR_KEY: "" } as unknown as Env;

    await expect(
      resolveAnthropicKey(db, env, DEFAULT_WORKSPACE_ID)
    ).rejects.toThrow(MissingConnectorKeyError);
  });
});

// --- the resource reset -----------------------------------------------------

const seedWorkspaceResources = async (workspaceId: string, tag: string) => {
  const { agent } = await createAgent(db, workspaceId, {
    instructions: "",
    name: `Ada ${tag}`,
    soul: "",
  });
  await setAgentRegistration(db, agent.id, {
    anthropicAgentId: `agt_${tag}`,
    memoryStoreId: `mem_${tag}`,
  });
  await db
    .update(agents)
    .set({ sessionId: `sesn_${tag}` })
    .where(eq(agents.id, agent.id));

  await db.insert(connectors).values({
    authKind: "oauth",
    id: `con_${tag}`,
    name: tag,
    status: "connected",
    url: `https://${tag}.example.com/mcp`,
    vaultCredentialId: `cred_${tag}`,
    vaultId: `vault_${tag}`,
    workspaceId,
  });

  await db.insert(skills).values({
    anthropicSkillId: `skill_${tag}`,
    description: "d",
    id: `sk_${tag}`,
    name: tag,
    slug: tag,
    syncStatus: "synced",
    workspaceId,
  });
  await db.insert(skillVersions).values({
    anthropicVersion: `ver_${tag}`,
    id: `skv_${tag}`,
    skillId: `sk_${tag}`,
    version: 1,
  });

  await db
    .insert(appConfig)
    .values({ key: environmentIdKeyFor(workspaceId), value: `env_${tag}` });

  return agent.id;
};

const anthropicStateOf = async (workspaceId: string) => {
  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.workspaceId, workspaceId));
  const [connector] = await db
    .select()
    .from(connectors)
    .where(eq(connectors.workspaceId, workspaceId));
  const [skill] = await db
    .select()
    .from(skills)
    .where(eq(skills.workspaceId, workspaceId));
  const [version] = await db
    .select()
    .from(skillVersions)
    .where(eq(skillVersions.skillId, skill?.id ?? ""));
  const [environment] = await db
    .select()
    .from(appConfig)
    .where(eq(appConfig.key, environmentIdKeyFor(workspaceId)));

  return {
    anthropicAgentId: agent?.anthropicAgentId ?? null,
    anthropicSkillId: skill?.anthropicSkillId ?? null,
    anthropicVersion: version?.anthropicVersion ?? null,
    environmentId: environment?.value ?? null,
    memoryStoreId: agent?.memoryStoreId ?? null,
    sessionId: agent?.sessionId ?? null,
    skillSyncStatus: skill?.syncStatus ?? null,
    syncStatus: agent?.syncStatus ?? null,
    vaultId: connector?.vaultId ?? null,
  };
};

describe("resetWorkspaceAnthropicResources", () => {
  test("forgets every id the old key created", async () => {
    await seedWorkspaceResources(DEFAULT_WORKSPACE_ID, "mine");

    await resetWorkspaceAnthropicResources(db, DEFAULT_WORKSPACE_ID);

    expect(await anthropicStateOf(DEFAULT_WORKSPACE_ID)).toEqual({
      anthropicAgentId: null,
      anthropicSkillId: null,
      anthropicVersion: null,
      environmentId: null,
      memoryStoreId: null,
      sessionId: null,
      skillSyncStatus: "unsynced",
      syncStatus: "unregistered",
      vaultId: null,
    });
  });

  test("leaves the other workspaces, and the global environment, alone", async () => {
    const { workspace } = await createWorkspace(db, {
      name: "Globex",
      owner: {
        clerkUserId: "user_2cOutsiderCCCCCCCCCCCC",
        email: "alan@example.com",
        imageUrl: "",
        name: "Alan Turing",
      },
    });
    await seedWorkspaceResources(DEFAULT_WORKSPACE_ID, "mine");
    await seedWorkspaceResources(workspace.id, "theirs");
    await db
      .insert(appConfig)
      .values({ key: ENVIRONMENT_ID_KEY, value: "env_global" });

    await resetWorkspaceAnthropicResources(db, DEFAULT_WORKSPACE_ID);

    const theirs = await anthropicStateOf(workspace.id);
    expect(theirs.anthropicAgentId).toBe("agt_theirs");
    expect(theirs.vaultId).toBe("vault_theirs");
    expect(theirs.anthropicSkillId).toBe("skill_theirs");
    expect(theirs.environmentId).toBe("env_theirs");

    const [global] = await db
      .select()
      .from(appConfig)
      .where(eq(appConfig.key, ENVIRONMENT_ID_KEY));
    expect(global?.value).toBe("env_global");
  });
});

describe("setWorkspaceAnthropicKey and deleteWorkspaceAnthropicKey", () => {
  test("a first set resets what the global key had registered", async () => {
    await seedWorkspaceResources(DEFAULT_WORKSPACE_ID, "mine");

    await store();

    expect(
      (await anthropicStateOf(DEFAULT_WORKSPACE_ID)).anthropicAgentId
    ).toBe(null);
  });

  test("removing the key resets, and reports the fallback", async () => {
    await store();
    await seedWorkspaceResources(DEFAULT_WORKSPACE_ID, "mine");

    const status = await deleteWorkspaceAnthropicKey(db, DEFAULT_WORKSPACE_ID);

    expect(status).toEqual({ configured: false, hint: null, setAt: null });
    expect(await db.select().from(workspaceAnthropicKeys)).toHaveLength(0);
    expect(
      (await anthropicStateOf(DEFAULT_WORKSPACE_ID)).anthropicAgentId
    ).toBe(null);
  });

  test("removing a key that was never set touches nothing", async () => {
    // The workspace was already on the global key, so its registrations are
    // exactly the ones that key made - resetting them would be pure damage.
    await seedWorkspaceResources(DEFAULT_WORKSPACE_ID, "mine");
    const before = await anthropicStateOf(DEFAULT_WORKSPACE_ID);

    await deleteWorkspaceAnthropicKey(db, DEFAULT_WORKSPACE_ID);

    expect(await anthropicStateOf(DEFAULT_WORKSPACE_ID)).toEqual(before);
  });
});
