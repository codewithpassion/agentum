import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Db } from "#/db/client";
import { agents } from "#/modules/agents/schema";
import {
  createAgent,
  getAgentById,
  markAgentsForConnectorResync,
  setAgentRegistration,
} from "#/modules/agents/service";
import { agentConnectors, connectors } from "#/modules/connectors/schema";
import { assignConnector } from "#/modules/connectors/service";
import { MAX_AGENT_CONNECTORS } from "#/modules/connectors/usability";
import type { AnthropicGateway, SyncAgentInput } from "./gateway";
import {
  type ConnectorResyncDeps,
  resyncAgentConnectors,
  sessionVaultIdsFor,
  syncAgentToAnthropic,
} from "./service";

/**
 * The rotation half of task 4c, against the shipped migrations in an in-memory
 * database and a faked gateway - the same combination `modules/connectors` uses.
 * Everything here goes through the deps-injected entry points, so no Anthropic
 * client is ever constructed.
 */

const APP_URL = "https://app.example.com";

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

interface GatewayCalls {
  registered: string[];
  synced: SyncAgentInput[];
}

const fakeGateway = (
  onSync?: () => void
): { calls: GatewayCalls; gateway: AnthropicGateway } => {
  const calls: GatewayCalls = { registered: [], synced: [] };
  const gateway: AnthropicGateway = {
    createSession: () =>
      Promise.resolve({ sessionId: "sesn_1", status: "running" as const }),
    deleteSession: () => Promise.resolve(),
    ensureEnvironment: () => Promise.resolve("env_1"),
    getSession: () => Promise.resolve("idle" as const),
    pollEvents: () => Promise.resolve({ cursor: undefined, events: [] }),
    registerAgent: (input) => {
      calls.registered.push(input.name);
      return Promise.resolve({
        anthropicAgentId: "agt_new",
        memoryStoreId: null,
      });
    },
    sendMessage: () => Promise.resolve(),
    syncAgent: (input) => {
      onSync?.();
      calls.synced.push(input);
      return Promise.resolve();
    },
  };
  return { calls, gateway };
};

let db: Db;

beforeEach(() => {
  db = migrate();
});

/** A registered agent, which is what a connector resync has to update. */
const registeredAgent = async (): Promise<string> => {
  const { agent } = await createAgent(db, {
    instructions: "",
    name: "Ada",
    soul: "",
  });
  await setAgentRegistration(db, agent.id, {
    anthropicAgentId: "agt_1",
    memoryStoreId: null,
  });
  return agent.id;
};

const addConnectorRow = async (
  id: string,
  overrides: Record<string, unknown> = {}
): Promise<string> => {
  await db.insert(connectors).values({
    authKind: "oauth",
    id,
    name: id,
    status: "connected",
    url: `https://${id}.example.com/mcp`,
    vaultCredentialId: `cred_${id}`,
    vaultId: `vault_${id}`,
    ...overrides,
  });
  return id;
};

const tokenHashOf = async (agentId: string): Promise<string | null> => {
  const [row] = await db
    .select({ hash: agents.mcpTokenHash })
    .from(agents)
    .where(eq(agents.id, agentId));
  return row?.hash ?? null;
};

const depsWith = (gateway: AnthropicGateway): ConnectorResyncDeps => ({
  appBaseUrl: APP_URL,
  db,
  gateway,
});

describe("resyncAgentConnectors", () => {
  test("rotates the MCP token and pushes the whole server array", async () => {
    const agentId = await registeredAgent();
    await addConnectorRow("aaaa");
    await assignConnector(db, "aaaa", agentId);
    const before = await tokenHashOf(agentId);
    const { calls, gateway } = fakeGateway();

    expect(await resyncAgentConnectors(depsWith(gateway), agentId)).toBe(
      "synced"
    );

    // The workspace URL embeds a token that only exists at issuance, so the
    // only way to rewrite the array is to mint a new one.
    expect(await tokenHashOf(agentId)).not.toBe(before);
    const [update] = calls.synced;
    expect(update?.mcpUrl).toStartWith(`${APP_URL}/mcp/`);
    expect(update?.connectors).toEqual([
      { name: "connector_aaaa", url: "https://aaaa.example.com/mcp" },
    ]);
  });

  test("clears the pending flag once the update lands", async () => {
    const agentId = await registeredAgent();
    await markAgentsForConnectorResync(db, [agentId]);

    await resyncAgentConnectors(depsWith(fakeGateway().gateway), agentId);

    expect((await getAgentById(db, agentId))?.connectorResyncPendingAt).toBe(
      null
    );
  });

  test("defers while the agent has a session, touching nothing", async () => {
    const agentId = await registeredAgent();
    await markAgentsForConnectorResync(db, [agentId]);
    await db
      .update(agents)
      .set({ sessionId: "sesn_live" })
      .where(eq(agents.id, agentId));
    const before = await tokenHashOf(agentId);
    const { calls, gateway } = fakeGateway();

    expect(await resyncAgentConnectors(depsWith(gateway), agentId)).toBe(
      "deferred"
    );

    // Rotating now would cut the running session off from the workspace MCP.
    expect(await tokenHashOf(agentId)).toBe(before);
    expect(calls.synced).toEqual([]);
    expect(
      (await getAgentById(db, agentId))?.connectorResyncPendingAt
    ).not.toBe(null);
  });

  test("keeps the debt when the update fails, so the next try repeats it", async () => {
    const agentId = await registeredAgent();
    await markAgentsForConnectorResync(db, [agentId]);
    const { gateway } = fakeGateway(() => {
      throw new Error("the API is down");
    });

    expect(await resyncAgentConnectors(depsWith(gateway), agentId)).toBe(
      "failed"
    );

    const agent = await getAgentById(db, agentId);
    expect(agent?.connectorResyncPendingAt).not.toBe(null);
    expect(agent?.syncStatus).toBe("error");
  });

  test("does nothing without a base URL to mint an endpoint from", async () => {
    const agentId = await registeredAgent();
    const before = await tokenHashOf(agentId);
    const { calls, gateway } = fakeGateway();

    expect(
      await resyncAgentConnectors({ appBaseUrl: null, db, gateway }, agentId)
    ).toBe("skipped");
    expect(await tokenHashOf(agentId)).toBe(before);
    expect(calls.synced).toEqual([]);
  });

  test("clamps at the cap and says so on the agent's sync status", async () => {
    const agentId = await registeredAgent();
    for (let index = 0; index <= MAX_AGENT_CONNECTORS; index += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: fixture rows are written in order
      await addConnectorRow(`c${index}`);
      // Straight into the join table: `assignConnector` refuses to go past the
      // cap, so this is the only way to build a row set that needs clamping.
      await db.insert(agentConnectors).values({
        agentId,
        connectorId: `c${index}`,
        id: crypto.randomUUID(),
      });
    }
    const { calls, gateway } = fakeGateway();

    await resyncAgentConnectors(depsWith(gateway), agentId);

    expect(calls.synced.at(0)?.connectors).toHaveLength(MAX_AGENT_CONNECTORS);
    const agent = await getAgentById(db, agentId);
    expect(agent?.syncStatus).toBe("error");
    expect(agent?.syncError).toContain("1 connector could not be attached");
  });
});

describe("syncAgentToAnthropic", () => {
  test("a profile update rotates nothing and preserves the server array", async () => {
    const agentId = await registeredAgent();
    await addConnectorRow("aaaa");
    await assignConnector(db, "aaaa", agentId);
    const before = await tokenHashOf(agentId);
    const { calls, gateway } = fakeGateway();

    await syncAgentToAnthropic(db, gateway, agentId);

    // Renames, roster refreshes and (in phase 5) skills take this path: no new
    // token, and `mcp_servers` is omitted so the API preserves it.
    expect(await tokenHashOf(agentId)).toBe(before);
    expect(calls.synced.at(0)?.mcpUrl).toBeUndefined();
    expect(calls.synced.at(0)?.connectors).toBeUndefined();
  });
});

describe("sessionVaultIdsFor", () => {
  test("gives the session the vaults of the usable connectors only", async () => {
    const agentId = await registeredAgent();
    await addConnectorRow("good");
    await addConnectorRow("off", { status: "disabled" });
    await addConnectorRow("never", {
      status: "auth_error",
      vaultCredentialId: null,
    });
    await addConnectorRow("flaky", { status: "auth_error" });
    for (const id of ["good", "off", "never", "flaky"]) {
      // biome-ignore lint/performance/noAwaitInLoops: assignments are written in order
      await assignConnector(db, id, agentId);
    }

    expect(await sessionVaultIdsFor(db, agentId)).toEqual([
      "vault_flaky",
      "vault_good",
    ]);
  });

  test("is empty for an agent with no connectors", async () => {
    expect(await sessionVaultIdsFor(db, await registeredAgent())).toEqual([]);
  });
});
