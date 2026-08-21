/**
 * Live probe of the Managed Agents API, run with the real key:
 *
 *   bun run anthropic-spike           (from apps/web) - session spike
 *   bun scripts/anthropic-spike.ts vaults              - vault CRUD spike
 *   bun scripts/anthropic-spike.ts skills              - skills + agent wiring
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
 *
 * The skills spike (Phase 5 entry) proves the two things the skills module
 * depends on: the upload shape of `POST /v1/skills` and `POST
 * /v1/skills/{id}/versions` (multipart, path-preserving filenames) with its
 * validation errors, and that `agents.update` takes `skills` with the same
 * partial-update-preserves-omitted semantics `syncAgent` already relies on for
 * `mcp_servers`. It creates one throwaway skill and one throwaway agent, both
 * stamped with the run's timestamp, and touches nothing else.
 */

import process from "node:process";
import Anthropic from "@anthropic-ai/sdk";
import type { BetaManagedAgentsMCPOAuthUpdateParams } from "@anthropic-ai/sdk/resources/beta/vaults/credentials";
import {
  AGENT_MODEL,
  AGENT_TOOLSET,
  ENVIRONMENT_NAME,
} from "#/modules/anthropic/config";
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
    model: AGENT_MODEL,
    name: `agentum-spike-${Date.now().toString(36)}`,
    system: "You are a terse test agent. Answer in exactly one word.",
  });
  process.stdout.write(`agent:        ${registered.anthropicAgentId}\n`);
  process.stdout.write(`memory store: ${registered.memoryStoreId}\n`);

  const session = await gateway.createSession({
    anthropicAgentId: registered.anthropicAgentId,
    memoryStoreId: registered.memoryStoreId,
    model: AGENT_MODEL,
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

// ---------------------------------------------------------------------------
// Skills spike (Phase 5 entry). One throwaway skill and one throwaway agent,
// both created here and cleaned up here. No pre-existing agent, environment,
// vault or memory store is read, updated or archived.
// ---------------------------------------------------------------------------

const SKILL_MCP_NAME = "spike";
/** Public-looking dummy: `agents.create` rejects loopback MCP URLs. */
const SKILL_MCP_URL = "https://mcp.spike-skills.example.com/mcp";
const SPIKE_SYSTEM = "You are a throwaway spike agent. Do nothing.";

/** The same shape `gateway.ts` builds, inlined so the spike stays standalone. */
const spikePermissive = {
  enabled: true,
  permission_policy: { type: "always_allow" as const },
};

const spikeAgentTools = [
  {
    default_config: spikePermissive,
    type: AGENT_TOOLSET as "agent_toolset_20260401",
  },
  {
    default_config: spikePermissive,
    mcp_server_name: SKILL_MCP_NAME,
    type: "mcp_toolset" as const,
  },
];

/**
 * The SDK sends `files` as repeated `files[]` multipart parts and (uniquely for
 * skills) does *not* strip the path from the filename, so the directory layout
 * of the skill travels in `File.name`.
 *
 * The whole multipart request is capped at 30 MB ("The Skills API accepts
 * requests up to 30MBs", probed separately; a 10 MB bundle uploads fine). No
 * per-file or file-count cap surfaced.
 */
const skillFile = (path: string, content: string): File =>
  new File([content], path, { type: "text/plain" });

const skillMd = (name: string, body: string): string =>
  `---
name: ${name}
description: Throwaway skill uploaded by the Agentum Phase 5 entry spike.
---

# ${name}

${body}
`;

const helloScript = (message: string): string =>
  `export const hello = (): string => "${message}";\n`;

/** Probes the SKILL.md rules without leaving anything behind: all must fail. */
const probeSkillValidation = async (
  client: Anthropic,
  dir: string
): Promise<void> => {
  await expectFailure("skills.create with no SKILL.md at the root", () =>
    client.beta.skills.create({
      files: [skillFile(`${dir}-nomd/scripts/hello.ts`, helloScript("hi"))],
    })
  );

  await expectFailure("skills.create with SKILL.md but no frontmatter", () =>
    client.beta.skills.create({
      files: [
        skillFile(
          `${dir}-nofm/SKILL.md`,
          "# no frontmatter here\n\njust prose\n"
        ),
      ],
    })
  );

  await expectFailure(
    "skills.create with frontmatter missing `description`",
    () =>
      client.beta.skills.create({
        files: [
          skillFile(
            `${dir}-nodesc/SKILL.md`,
            `---\nname: ${dir}-nodesc\n---\n\n# body\n`
          ),
        ],
      })
  );

  await expectFailure(
    "skills.create with frontmatter `name` != directory name",
    () =>
      client.beta.skills.create({
        files: [
          skillFile(
            `${dir}-mismatch/SKILL.md`,
            skillMd("totally-different-name", "Name does not match the dir.")
          ),
        ],
      })
  );

  await expectFailure("skills.create with two top-level directories", () =>
    client.beta.skills.create({
      files: [
        skillFile(`${dir}-two/SKILL.md`, skillMd(`${dir}-two`, "First dir.")),
        skillFile(
          `${dir}-other/SKILL.md`,
          skillMd(`${dir}-other`, "Second dir.")
        ),
      ],
    })
  );
};

interface SkillRefs {
  skillId: string;
  versionOne: string;
  versionTwo: string;
}

/**
 * Spike 2. Every probe here answers one plan assumption:
 * - does a skills-only update preserve `mcp_servers`/`tools`/`system`?
 * - does an update without `skills` preserve the skills?
 * - is the literal `"latest"` accepted, and does a tracked skill *move* when a
 *   new version is published, or is it resolved once at update time?
 *
 * Returns whether the skill was deleted by the in-use delete probe.
 */
const probeAgentSkills = async (
  client: Anthropic,
  refs: SkillRefs
): Promise<boolean> => {
  const agent = await client.beta.agents.create({
    description: "Throwaway agent for the Agentum Phase 5 skills spike.",
    mcp_servers: [{ name: SKILL_MCP_NAME, type: "url", url: SKILL_MCP_URL }],
    model: AGENT_MODEL,
    name: `agentum-spike-skills-${Date.now().toString(36)}`,
    system: SPIKE_SYSTEM,
    tools: spikeAgentTools,
  });
  dump("agents.create (throwaway spike agent)", agent);

  try {
    dump(
      "agents.update skills only, version omitted (track latest)",
      await client.beta.agents.update(agent.id, {
        skills: [{ skill_id: refs.skillId, type: "custom" }],
      })
    );
    dump(
      "agents.retrieve after skills-only update (mcp_servers/tools/system survive?)",
      await client.beta.agents.retrieve(agent.id)
    );

    await expectFailure('agents.update with the literal version "latest"', () =>
      client.beta.agents.update(agent.id, {
        skills: [{ skill_id: refs.skillId, type: "custom", version: "latest" }],
      })
    );

    dump(
      "agents.update with a pinned concrete version (v1)",
      await client.beta.agents.update(agent.id, {
        skills: [
          { skill_id: refs.skillId, type: "custom", version: refs.versionOne },
        ],
      })
    );

    // Back to tracking latest, then ask the question 5d rests on: does the
    // stored version follow a newly published version, or was it frozen when
    // the update ran? (v2 already exists at this point.)
    dump(
      "agents.update back to tracking latest",
      await client.beta.agents.update(agent.id, {
        skills: [{ skill_id: refs.skillId, type: "custom" }],
      })
    );
    dump(
      `PROPAGATION: does skills[].version equal v2 (${refs.versionTwo}) or v1 (${refs.versionOne})?`,
      (await client.beta.agents.retrieve(agent.id)).skills
    );

    dump(
      "agents.update without `skills` (system only)",
      await client.beta.agents.update(agent.id, {
        system: `${SPIKE_SYSTEM} Edited.`,
      })
    );
    dump(
      "PRESERVED: agents.retrieve after a skills-less update",
      (await client.beta.agents.retrieve(agent.id)).skills
    );

    // The "skill still has versions" check fires before any in-use check, so
    // the versions have to go first for the in-use question to be answerable.
    await expectFailure("skills.versions.delete (v1, not the latest)", () =>
      client.beta.skills.versions.delete(refs.versionOne, {
        skill_id: refs.skillId,
      })
    );
    await expectFailure(
      "skills.versions.delete (v2, the latest, while an agent tracks latest)",
      () =>
        client.beta.skills.versions.delete(refs.versionTwo, {
          skill_id: refs.skillId,
        })
    );
    const inUseDelete = await expectFailure(
      "skills.delete (no versions left) while an agent still references it",
      () => client.beta.skills.delete(refs.skillId)
    );

    dump(
      "agents.update skills: [] (unassign)",
      await client.beta.agents.update(agent.id, { skills: [] })
    );

    return inUseDelete !== null;
  } finally {
    // Archive is permanent, so it may only ever name the id this run created.
    const archived = await client.beta.agents
      .archive(agent.id)
      .catch((error: unknown) => {
        dumpError(`archive spike agent ${agent.id}`, error);
        return null;
      });
    dump("agents.archive (throwaway spike agent)", archived);
  }
};

/** `skills.delete` 400s while any version exists, so versions go first. */
const deleteSkillWithVersions = async (
  client: Anthropic,
  skillId: string,
  label: string
): Promise<void> => {
  const remaining = await client.beta.skills.versions
    .list(skillId)
    .catch((error: unknown) => {
      dumpError(`cleanup list versions ${skillId}`, error);
      return null;
    });
  for (const version of remaining?.data ?? []) {
    // Sequential on purpose: one failure must not skip the rest.
    // biome-ignore lint/performance/noAwaitInLoops: sequential best-effort cleanup
    await client.beta.skills.versions
      .delete(version.version, { skill_id: skillId })
      .catch((error: unknown) =>
        dumpError(`cleanup version ${version.version}`, error)
      );
  }
  const gone = await client.beta.skills
    .delete(skillId)
    .catch((error: unknown) => {
      dumpError(`cleanup skill ${skillId} (${label})`, error);
      return null;
    });
  dump("skills.delete (cleanup, after deleting every version)", gone);
};

const runSkillsSpike = async (client: Anthropic): Promise<void> => {
  const dir = `spike-skill-${Date.now().toString(36)}`;

  const skill = await client.beta.skills.create({
    display_title: `Agentum spike ${dir}`,
    files: [
      skillFile(
        `${dir}/SKILL.md`,
        skillMd(dir, "Run scripts/hello.ts and report what it returns.")
      ),
      skillFile(`${dir}/scripts/hello.ts`, helloScript("hello from v1")),
    ],
  });
  dump("skills.create (v1)", skill);

  let deleted = false;
  try {
    const versionOne = skill.latest_version ?? "";
    const second = await client.beta.skills.versions.create(skill.id, {
      files: [
        skillFile(
          `${dir}/SKILL.md`,
          skillMd(dir, "Run scripts/hello.ts and scripts/bye.ts.")
        ),
        skillFile(`${dir}/scripts/hello.ts`, helloScript("hello from v2")),
        skillFile(`${dir}/scripts/bye.ts`, helloScript("bye from v2")),
      ],
    });
    dump("skills.versions.create (v2)", second);

    dump("skills.retrieve", await client.beta.skills.retrieve(skill.id));
    const versions = await client.beta.skills.versions.list(skill.id);
    dump("skills.versions.list", versions.data);
    dump(
      "skills.versions.retrieve (v1)",
      await client.beta.skills.versions.retrieve(versionOne, {
        skill_id: skill.id,
      })
    );
    const listed = await client.beta.skills.list({ source: "custom" });
    dump("skills.list (source=custom, first page)", {
      count: listed.data.length,
      first: listed.data[0],
      includes_created: listed.data.some((entry) => entry.id === skill.id),
    });

    await expectFailure("skills.versions.download (v1)", async () => {
      const archive = await client.beta.skills.versions.download(versionOne, {
        skill_id: skill.id,
      });
      return {
        bytes: (await archive.arrayBuffer()).byteLength,
        content_type: archive.headers.get("content-type"),
        status: archive.status,
      };
    });

    await probeSkillValidation(client, dir);

    deleted = await probeAgentSkills(client, {
      skillId: skill.id,
      versionOne,
      versionTwo: second.version,
    });
  } finally {
    if (deleted) {
      process.stdout.write(`skill ${skill.id} already deleted in-probe\n`);
    } else {
      await deleteSkillWithVersions(client, skill.id, dir);
    }
  }
};

// ---------------------------------------------------------------------------
// Agent-name uniqueness spike (Phase 5, multi-tenancy). Agent names are only
// unique per *workspace* now, and every workspace's agents are registered into
// the one shared Anthropic organisation - so the question is whether
// `agents.create` refuses a name that is already taken. Creates two agents with
// one name plus a third to rename, and archives all of them.
// ---------------------------------------------------------------------------

const NAME_SPIKE_SYSTEM = "You are a throwaway spike agent. Do nothing.";

const createNamedAgent = (client: Anthropic, name: string) =>
  client.beta.agents.create({
    description: "Throwaway agent from the Agentum name-uniqueness spike.",
    model: AGENT_MODEL,
    name,
    system: NAME_SPIKE_SYSTEM,
    tools: [
      {
        default_config: spikePermissive,
        type: AGENT_TOOLSET as "agent_toolset_20260401",
      },
    ],
  });

const runNamesSpike = async (client: Anthropic): Promise<void> => {
  const name = `agentum-spike-dup-${Date.now().toString(36)}`;
  const created: string[] = [];

  try {
    const first = await createNamedAgent(client, name);
    created.push(first.id);
    dump("agents.create #1", { id: first.id, name: first.name });

    // The whole question: same name, same organisation, no environment in
    // sight (agents are org-level - the environment only enters at session
    // create).
    try {
      const second = await createNamedAgent(client, name);
      created.push(second.id);
      dump("agents.create #2 with the SAME name [DUPLICATES ALLOWED]", {
        id: second.id,
        name: second.name,
        sameIdAsFirst: second.id === first.id,
      });
    } catch (error) {
      dumpError("agents.create #2 with the SAME name [REJECTED]", error);
    }

    // The rename path `syncAgent` takes on every roster resync.
    const third = await createNamedAgent(client, `${name}-other`);
    created.push(third.id);
    try {
      const renamed = await client.beta.agents.update(third.id, { name });
      dump("agents.update renaming INTO the taken name [ALLOWED]", {
        id: renamed.id,
        name: renamed.name,
      });
    } catch (error) {
      dumpError("agents.update renaming INTO the taken name [REJECTED]", error);
    }

    // How a caller would find "the agent called X" if names were unique.
    const listed: { id: string; name: string }[] = [];
    for await (const agent of client.beta.agents.list()) {
      if (agent.name === name) {
        listed.push({ id: agent.id, name: agent.name });
      }
    }
    dump(`agents.list entries named "${name}"`, listed);
  } finally {
    for (const id of created) {
      // Archive is the terminal state; agents have no delete.
      // biome-ignore lint/performance/noAwaitInLoops: a handful of cleanups, in order
      await client.beta.agents.archive(id).catch((error: unknown) => {
        dumpError(`archive ${id}`, error);
      });
    }
    process.stdout.write(`cleaned up: archived ${created.length} agent(s)\n`);
  }
};

const [, , mode] = process.argv;
if (mode === "names") {
  await runNamesSpike(new Anthropic({ apiKey: requireApiKey() }));
} else if (mode === "vaults") {
  await runVaultSpike(new Anthropic({ apiKey: requireApiKey() }));
} else if (mode === "skills") {
  await runSkillsSpike(new Anthropic({ apiKey: requireApiKey() }));
} else {
  await main();
}
