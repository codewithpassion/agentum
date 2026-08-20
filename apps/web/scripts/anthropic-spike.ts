/**
 * Live probe of the Managed Agents API, run with the real key:
 *
 *   bun run anthropic-spike           (from apps/web) - session spike
 *   bun scripts/anthropic-spike.ts vaults              - vault CRUD spike
 *
 * The session spike proves the four things the router depends on - a reusable
 * environment, an agent plus memory store, a session seeded with
 * `initial_events`, and polled events with a client-side cursor - then cleans up
 * after itself. No MCP server is attached: Anthropic's cloud cannot reach a
 * laptop, and this is about the API shape, not our tools.
 *
 * The vault spike (Phase 4 entry) proves the connector credential lifecycle:
 * vault create/list, `static_bearer` and `mcp_oauth` (with a `refresh` block)
 * credentials, secret-field updates, `mcp_server_url` immutability, and the
 * archive/delete cleanup path. It touches only the vault it creates.
 */

import process from "node:process";
import Anthropic from "@anthropic-ai/sdk";
import type { BetaManagedAgentsMCPOAuthUpdateParams } from "@anthropic-ai/sdk/resources/beta/vaults/credentials";
import { ENVIRONMENT_NAME } from "#/modules/anthropic/config";
import type { EventCursor } from "#/modules/anthropic/events";
import { isSessionReusable } from "#/modules/anthropic/events";
import { createAnthropicGateway } from "#/modules/anthropic/gateway";

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 180_000;
const PROMPT = "Reply with exactly: pong";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const requireApiKey = (): string => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to apps/web/.env.local."
    );
  }
  return apiKey;
};

const main = async (): Promise<void> => {
  const client = new Anthropic({ apiKey: requireApiKey() });

  // A cache that forgets between calls, so the second ensureEnvironment() below
  // exercises the create -> 409 -> list -> reuse path for real.
  const gateway = createAnthropicGateway(client, {
    cache: {
      read: () => Promise.resolve(null),
      write: () => Promise.resolve(),
    },
    environmentName: ENVIRONMENT_NAME,
  });

  const first = await gateway.ensureEnvironment();
  const second = await gateway.ensureEnvironment();
  process.stdout.write(`environment (create-or-reuse): ${first}\n`);
  process.stdout.write(
    `environment (second call):     ${second} ${first === second ? "[reused]" : "[MISMATCH]"}\n`
  );

  const registered = await gateway.registerAgent({
    instructions: "Answer with a single word.",
    mcpUrl: "",
    name: `agentum-spike-${Date.now().toString(36)}`,
    system: "You are a terse test agent. Answer in exactly one word.",
  });
  process.stdout.write(`agent:        ${registered.anthropicAgentId}\n`);
  process.stdout.write(`memory store: ${registered.memoryStoreId}\n`);

  const session = await gateway.createSession({
    anthropicAgentId: registered.anthropicAgentId,
    memoryStoreId: registered.memoryStoreId,
    text: PROMPT,
    title: "Agentum spike",
  });
  process.stdout.write(`session:      ${session.sessionId}\n`);
  process.stdout.write(`status:       ${session.status}\n`);
  process.stdout.write(
    `trace:        https://platform.claude.com/workspaces/default/sessions/${session.sessionId}\n\n`
  );

  let cursor: EventCursor | undefined;
  let { status } = session;
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    // Polling is a sequential loop by definition: each request starts where the
    // last one left off.
    // biome-ignore lint/performance/noAwaitInLoops: a poll loop is sequential by nature
    const page = await gateway.pollEvents(session.sessionId, cursor);
    ({ cursor } = page);
    for (const event of page.events) {
      process.stdout.write(
        `  ${event.type}${event.text ? `: ${event.text}` : ""}\n`
      );
    }
    status = await gateway.getSession(session.sessionId);
    if (!isSessionReusable(status) || status === "idle") {
      break;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  process.stdout.write(`\nfinal status: ${status}\n`);

  await gateway.deleteSession(session.sessionId);
  if (registered.memoryStoreId) {
    await client.beta.memoryStores.delete(registered.memoryStoreId);
  }
  // Agents have no delete - archive is the terminal state, which is what a
  // throwaway wants.
  await client.beta.agents.archive(registered.anthropicAgentId);
  process.stdout.write(
    "cleaned up: session deleted, memory store deleted, agent archived (environment kept)\n"
  );
};

// ---------------------------------------------------------------------------
// Vault CRUD spike (Phase 4 entry). Everything below only ever touches the
// vault this run creates - no agent, environment or memory store is archived.
// ---------------------------------------------------------------------------

const BEARER_MCP_URL = "https://mcp.spike-bearer.example.com/mcp";
const OAUTH_MCP_URL = "https://mcp.spike-oauth.example.com/mcp";
const OAUTH_MCP_URL_RENAMED = "https://mcp.spike-renamed.example.com/mcp";
const OAUTH_TOKEN_ENDPOINT = "https://auth.spike-oauth.example.com/oauth/token";
const ONE_HOUR_MS = 3_600_000;

const dump = (label: string, value: unknown): void => {
  process.stdout.write(`--- ${label}\n${JSON.stringify(value, null, 2)}\n\n`);
};

const dumpError = (label: string, error: unknown): void => {
  if (error instanceof Anthropic.APIError) {
    dump(`${label} [status=${error.status} request_id=${error.requestID}]`, {
      body: error.error,
      message: error.message,
    });
    return;
  }
  dump(`${label} [not an APIError]`, String(error));
};

/** Runs a call that is expected to fail; returns the value if it succeeds anyway. */
const expectFailure = async (
  label: string,
  run: () => Promise<unknown>
): Promise<unknown> => {
  try {
    const value = await run();
    dump(`${label} [UNEXPECTED SUCCESS]`, value);
    return value;
  } catch (error) {
    dumpError(label, error);
    return null;
  }
};

const createStaticBearer = (client: Anthropic, vaultId: string) =>
  client.beta.vaults.credentials.create(vaultId, {
    auth: {
      mcp_server_url: BEARER_MCP_URL,
      token: "spike-dummy-bearer-token",
      type: "static_bearer",
    },
    display_name: "spike static bearer",
    metadata: { connector_id: "spike-bearer" },
  });

const createMcpOAuth = (client: Anthropic, vaultId: string, url: string) =>
  client.beta.vaults.credentials.create(vaultId, {
    auth: {
      access_token: "spike-dummy-access-token",
      expires_at: new Date(Date.now() + ONE_HOUR_MS).toISOString(),
      mcp_server_url: url,
      refresh: {
        client_id: "spike-dummy-client-id",
        refresh_token: "spike-dummy-refresh-token",
        scope: "read write",
        token_endpoint: OAUTH_TOKEN_ENDPOINT,
        token_endpoint_auth: { type: "none" },
      },
      type: "mcp_oauth",
    },
    display_name: "spike mcp oauth",
    metadata: { connector_id: "spike-oauth" },
  });

/** Secret fields only - the shape "re-authorize an existing connector" needs. */
const updateSecrets = (client: Anthropic, vaultId: string, id: string) =>
  client.beta.vaults.credentials.update(id, {
    auth: {
      access_token: "spike-rotated-access-token",
      expires_at: new Date(Date.now() + 2 * ONE_HOUR_MS).toISOString(),
      refresh: { refresh_token: "spike-rotated-refresh-token" },
      type: "mcp_oauth",
    },
    display_name: "spike mcp oauth (rotated)",
    vault_id: vaultId,
  });

/**
 * `mcp_server_url` is absent from the update params by design; the cast asks the
 * live API what it does with the field anyway - reject, or silently ignore.
 */
const updateKeyField = (client: Anthropic, vaultId: string, id: string) =>
  client.beta.vaults.credentials.update(id, {
    auth: {
      mcp_server_url: OAUTH_MCP_URL_RENAMED,
      type: "mcp_oauth",
    } as unknown as BetaManagedAgentsMCPOAuthUpdateParams,
    vault_id: vaultId,
  });

const listCredentials = async (
  client: Anthropic,
  vaultId: string,
  includeArchived: boolean
): Promise<void> => {
  const page = await client.beta.vaults.credentials.list(vaultId, {
    include_archived: includeArchived,
  });
  dump(`credentials.list (include_archived=${includeArchived})`, page.data);
};

/**
 * Two answers the per-connector-vault topology rests on: whether the
 * `mcp_server_url` uniqueness is scoped to the vault or the whole workspace,
 * and whether "Remove connector" can delete a vault that still holds a live
 * credential (i.e. whether archive is a required first step).
 */
const probeSecondVault = async (
  client: Anthropic,
  takenUrl: string
): Promise<void> => {
  const other = await client.beta.vaults.create({
    display_name: `agentum-spike-second-${Date.now().toString(36)}`,
  });
  dump("vaults.create (second vault)", other);

  try {
    await expectFailure(
      "credentials.create mcp_oauth with a URL already used in another vault",
      () => createMcpOAuth(client, other.id, takenUrl)
    );
    dump(
      "vaults.delete (non-empty, never archived)",
      await client.beta.vaults.delete(other.id)
    );
  } catch (error) {
    dumpError("second vault probe", error);
    await client.beta.vaults
      .delete(other.id)
      .catch((cleanup: unknown) =>
        dumpError(`cleanup vault ${other.id}`, cleanup)
      );
  }
};

const runVaultSpike = async (client: Anthropic): Promise<void> => {
  const vault = await client.beta.vaults.create({
    display_name: `agentum-spike-${Date.now().toString(36)}`,
    metadata: { origin: "anthropic-spike" },
  });
  dump("vaults.create", vault);
  const live = new Set<string>();

  try {
    const vaults = await client.beta.vaults.list();
    dump("vaults.list (first page)", {
      count: vaults.data.length,
      first: vaults.data[0],
      includes_created: vaults.data.some((entry) => entry.id === vault.id),
    });

    const bearer = await createStaticBearer(client, vault.id);
    live.add(bearer.id);
    dump("credentials.create static_bearer", bearer);

    const oauth = await createMcpOAuth(client, vault.id, OAUTH_MCP_URL);
    live.add(oauth.id);
    dump("credentials.create mcp_oauth (+refresh)", oauth);

    const duplicate = await expectFailure(
      "credentials.create mcp_oauth duplicate mcp_server_url",
      () => createMcpOAuth(client, vault.id, OAUTH_MCP_URL)
    );
    if (duplicate && typeof duplicate === "object" && "id" in duplicate) {
      live.add(String(duplicate.id));
    }

    await probeSecondVault(client, OAUTH_MCP_URL);

    dump(
      "credentials.update secrets (access_token + refresh_token)",
      await updateSecrets(client, vault.id, oauth.id)
    );

    await expectFailure("credentials.update mcp_server_url (key field)", () =>
      updateKeyField(client, vault.id, oauth.id)
    );
    dump(
      "credentials.retrieve after key-field update attempt",
      await client.beta.vaults.credentials.retrieve(oauth.id, {
        vault_id: vault.id,
      })
    );

    dump(
      "credentials.archive static_bearer",
      await client.beta.vaults.credentials.archive(bearer.id, {
        vault_id: vault.id,
      })
    );
    await listCredentials(client, vault.id, false);
    await listCredentials(client, vault.id, true);

    dump(
      "credentials.delete (previously archived)",
      await client.beta.vaults.credentials.delete(bearer.id, {
        vault_id: vault.id,
      })
    );
    live.delete(bearer.id);

    dump(
      "credentials.delete (never archived)",
      await client.beta.vaults.credentials.delete(oauth.id, {
        vault_id: vault.id,
      })
    );
    live.delete(oauth.id);

    dump("vaults.archive", await client.beta.vaults.archive(vault.id));
  } finally {
    for (const id of live) {
      // Cleanup is sequential on purpose: one failure must not skip the rest.
      // biome-ignore lint/performance/noAwaitInLoops: sequential best-effort cleanup
      await client.beta.vaults.credentials
        .delete(id, { vault_id: vault.id })
        .catch((error: unknown) =>
          dumpError(`cleanup credential ${id}`, error)
        );
    }
    const deleted = await client.beta.vaults
      .delete(vault.id)
      .catch((error: unknown) => {
        dumpError(`cleanup vault ${vault.id}`, error);
        return null;
      });
    dump("vaults.delete", deleted);
  }
};

if (process.argv[2] === "vaults") {
  await runVaultSpike(new Anthropic({ apiKey: requireApiKey() }));
} else {
  await main();
}
