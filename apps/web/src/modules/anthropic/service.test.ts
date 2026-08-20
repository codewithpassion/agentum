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
import { skills, skillVersions } from "#/modules/skills/schema";
import { assignSkill } from "#/modules/skills/service";
import {
  createWorkspace,
  DEFAULT_WORKSPACE_ID,
} from "#/modules/workspaces/service";
import type {
  AnthropicGateway,
  SyncAgentInput,
  SyncAgentSkillsInput,
} from "./gateway";
import {
  type ConnectorResyncDeps,
  resyncAgentConnectors,
  sessionVaultIdsFor,
  syncAgentSkillsToAnthropic,
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
  skillsOnly: SyncAgentSkillsInput[];
  synced: SyncAgentInput[];
}

const fakeGateway = (
  onSync?: () => void
): { calls: GatewayCalls; gateway: AnthropicGateway } => {
  const calls: GatewayCalls = { registered: [], skillsOnly: [], synced: [] };
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
    syncAgentSkills: (input) => {
      calls.skillsOnly.push(input);
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
  const { agent } = await createAgent(db, DEFAULT_WORKSPACE_ID, {
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
    workspaceId: DEFAULT_WORKSPACE_ID,
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

    expect(
      (await getAgentById(db, DEFAULT_WORKSPACE_ID, agentId))
        ?.connectorResyncPendingAt
    ).toBe(null);
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
      (await getAgentById(db, DEFAULT_WORKSPACE_ID, agentId))
        ?.connectorResyncPendingAt
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

    const agent = await getAgentById(db, DEFAULT_WORKSPACE_ID, agentId);
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
    const agent = await getAgentById(db, DEFAULT_WORKSPACE_ID, agentId);
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

describe("syncAgentSkillsToAnthropic", () => {
  const addSkillRow = async (
    slug: string,
    overrides: {
      anthropicSkillId?: string | null;
      anthropicVersion?: string;
    } = {}
  ): Promise<string> => {
    const id = `skill-${slug}`;
    await db.insert(skills).values({
      anthropicSkillId:
        overrides.anthropicSkillId === undefined
          ? `skill_${slug}`
          : overrides.anthropicSkillId,
      description: "does a thing",
      id,
      name: slug,
      slug,
      syncStatus: "synced",
      workspaceId: DEFAULT_WORKSPACE_ID,
    });
    await db.insert(skillVersions).values({
      anthropicVersion: overrides.anthropicVersion ?? null,
      id: `version-${slug}`,
      skillId: id,
      version: 1,
    });
    return id;
  };

  test("pushes the assignments without rotating the MCP token", async () => {
    const agentId = await registeredAgent();
    const skillId = await addSkillRow("weekly-report");
    await assignSkill(db, { agentId, skillId });
    const before = await tokenHashOf(agentId);
    const { calls, gateway } = fakeGateway();

    expect(await syncAgentSkillsToAnthropic(db, gateway, agentId)).toBe(true);

    // The guarantee 5b rests on: no rotation, and no full update either - so
    // the registered `mcp_servers` (and the token inside it) is untouched.
    expect(await tokenHashOf(agentId)).toBe(before);
    expect(calls.synced).toEqual([]);
    expect(calls.skillsOnly).toEqual([
      {
        anthropicAgentId: "agt_1",
        skills: [{ skillId: "skill_weekly-report", version: "latest" }],
      },
    ]);
    expect(
      (await getAgentById(db, DEFAULT_WORKSPACE_ID, agentId))?.syncStatus
    ).toBe("synced");
  });

  test("sends the pinned version's own mirror id", async () => {
    const agentId = await registeredAgent();
    const skillId = await addSkillRow("pinned", {
      anthropicVersion: "1787195643170342",
    });
    await assignSkill(db, { agentId, pinnedVersion: 1, skillId });
    const { calls, gateway } = fakeGateway();

    await syncAgentSkillsToAnthropic(db, gateway, agentId);

    expect(calls.skillsOnly.at(0)?.skills).toEqual([
      { skillId: "skill_pinned", version: "1787195643170342" },
    ]);
  });

  test("skips an unmirrored skill and says so on the agent", async () => {
    const agentId = await registeredAgent();
    const skillId = await addSkillRow("draft", { anthropicSkillId: null });
    await assignSkill(db, { agentId, skillId });
    const { calls, gateway } = fakeGateway();

    await syncAgentSkillsToAnthropic(db, gateway, agentId);

    expect(calls.skillsOnly.at(0)?.skills).toEqual([]);
    const agent = await getAgentById(db, DEFAULT_WORKSPACE_ID, agentId);
    expect(agent?.syncStatus).toBe("error");
    expect(agent?.syncError).toContain('"draft"');
  });

  test("does nothing for an agent that is not registered yet", async () => {
    const { agent } = await createAgent(db, DEFAULT_WORKSPACE_ID, {
      instructions: "",
      name: "Grace",
      soul: "",
    });
    const { calls, gateway } = fakeGateway();

    expect(await syncAgentSkillsToAnthropic(db, gateway, agent.id)).toBe(false);
    expect(calls.skillsOnly).toEqual([]);
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

// --- tenancy ----------------------------------------------------------------

/**
 * Two workspaces, an agent called "Researcher" in each. `agents.name` is only
 * unique per workspace now, and both registrations land in the one shared
 * Anthropic organisation - so the questions are whether that is allowed, and
 * whether either agent is ever told about the other.
 *
 * The name goes over verbatim: `scripts/anthropic-spike.ts names` created two
 * agents with one name against the live API and both were accepted (2026-08-20,
 * recorded in docs/plan-multi-tenancy.md). What must not cross is the roster.
 */
describe("two workspaces, one agent name", () => {
  const seedWorkspace = async (
    name: string,
    clerkUserId: string
  ): Promise<{ researcher: string; teammate: string; workspaceId: string }> => {
    const { workspace } = await createWorkspace(db, {
      name,
      owner: {
        clerkUserId,
        email: `${clerkUserId}@example.com`,
        imageUrl: null,
        name: "Owner",
      },
    });
    const { agent: researcher } = await createAgent(db, workspace.id, {
      instructions: "",
      name: "Researcher",
      soul: "",
    });
    const { agent: teammate } = await createAgent(db, workspace.id, {
      instructions: "",
      // Distinct per workspace, so a roster that crossed over would name it.
      name: `${name} Teammate`,
      soul: `the ${name} specialist`,
    });
    await setAgentRegistration(db, researcher.id, {
      anthropicAgentId: `agt_${name}_researcher`,
      memoryStoreId: null,
    });
    await setAgentRegistration(db, teammate.id, {
      anthropicAgentId: `agt_${name}_teammate`,
      memoryStoreId: null,
    });
    return {
      researcher: researcher.id,
      teammate: teammate.id,
      workspaceId: workspace.id,
    };
  };

  test("both register under the same name, and each roster stops at its own workspace", async () => {
    const alpha = await seedWorkspace("Alpha", "user_2aAdaAAAAAAAAAAAAAAAAAAA");
    const beta = await seedWorkspace("Beta", "user_2bBobBBBBBBBBBBBBBBBBBBB");
    const { calls, gateway } = fakeGateway();

    await syncAgentToAnthropic(db, gateway, alpha.researcher);
    await syncAgentToAnthropic(db, gateway, beta.researcher);

    const [first, second] = calls.synced;
    expect(first?.name).toBe("Researcher");
    expect(second?.name).toBe("Researcher");
    // Each is a distinct Anthropic-side agent; only the display name collides.
    expect(first?.anthropicAgentId).not.toBe(second?.anthropicAgentId);

    // The roster is the leak that no response body would show: it reaches the
    // agent through its system prompt.
    expect(first?.system).toContain("@Alpha Teammate");
    expect(first?.system).not.toContain("@Beta Teammate");
    expect(second?.system).toContain("@Beta Teammate");
    expect(second?.system).not.toContain("@Alpha Teammate");
  });

  test("a session gets the vaults of its own agent's connectors and no others", async () => {
    const alpha = await seedWorkspace("Alpha", "user_2aAdaAAAAAAAAAAAAAAAAAAA");
    const beta = await seedWorkspace("Beta", "user_2bBobBBBBBBBBBBBBBBBBBBB");
    // The same connector URL in both workspaces - the case the plan called the
    // "vault trap". One vault per connector row is what keeps them apart.
    await addConnectorRow("shared-alpha", {
      url: "https://mcp.example.com/mcp",
      workspaceId: alpha.workspaceId,
    });
    await addConnectorRow("shared-beta", {
      url: "https://mcp.example.com/mcp",
      workspaceId: beta.workspaceId,
    });
    await assignConnector(db, "shared-alpha", alpha.researcher);
    await assignConnector(db, "shared-beta", beta.researcher);

    expect(await sessionVaultIdsFor(db, alpha.researcher)).toEqual([
      "vault_shared-alpha",
    ]);
    expect(await sessionVaultIdsFor(db, beta.researcher)).toEqual([
      "vault_shared-beta",
    ]);
  });
});
