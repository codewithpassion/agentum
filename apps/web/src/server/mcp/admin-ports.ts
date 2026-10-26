// The `admin` group of the platform MCP tools (X.10): setup calls for an
// `hm_key_` key, over the admin service. The service checks the key and
// writes the audit event; this adapter only maps shapes. Nothing returned
// carries a secret value.
import type {
  AdminAgentInfo,
  AdminPort,
  AdminSecretInfo,
  ThreadInfo,
} from "@repo/mcp/ports";
import { ToolError } from "@repo/mcp/result";
import type { AgentRecord } from "@repo/services/agents";
import type { ThreadRecord } from "@repo/services/inbox";
import type { SecretSummary } from "@repo/services/secrets";
import type { Principal } from "@repo/services/workspaces";
import type { Services } from "../compose.ts";
import { guarded } from "./guarded.ts";

const toAgentInfo = (agent: AgentRecord): AdminAgentInfo => ({
  id: agent.id,
  model: agent.model,
  name: agent.name,
  runtime: agent.runtime,
  slug: agent.slug,
});

const toSecretInfo = (secret: SecretSummary): AdminSecretInfo => ({
  hosts:
    secret.mode === "proxy"
      ? secret.rules.map((rule) => rule.host)
      : secret.allowedHosts,
  id: secret.id,
  mode: secret.mode,
  name: secret.name,
});

const toThreadInfo = (thread: ThreadRecord): ThreadInfo => ({
  createdAt: thread.createdAt,
  id: thread.id,
  lastPostAt: thread.lastPostAt,
  title: thread.title,
});

export const createAdminPorts = ({
  principal,
  services,
}: {
  principal: Principal;
  services: Pick<Services, "admin" | "agents" | "connectors">;
}): AdminPort => {
  const { admin, agents, connectors } = services;

  /** The agent id for a slug or an id, among all active agents of the workspace. */
  const agentIdOf = async (reference: string): Promise<string> => {
    const found = (await agents.list(principal)).find(
      (agent) => agent.slug === reference || agent.id === reference
    );
    if (!found) {
      throw new ToolError(
        "not_found",
        `No agent "${reference}". Call list_agents for the names you can use.`
      );
    }
    return found.id;
  };

  return {
    createAgent: (input) =>
      guarded(async () =>
        toAgentInfo(await admin.createAgent(principal, input))
      ),

    createApiKey: (input) =>
      guarded(async () => {
        const { key, secret } = await admin.createApiKey(principal, input);
        return {
          access: key.access,
          id: key.id,
          name: key.name,
          prefix: key.prefix,
          secret,
        };
      }),

    createEnrolmentCode: (input) =>
      guarded(() => admin.createEnrolmentCode(principal, input)),

    createInboxThread: (input) =>
      guarded(async () =>
        toThreadInfo(await admin.createInboxThread(principal, input))
      ),

    createSecret: (input) =>
      guarded(async () =>
        toSecretInfo(await admin.createSecret(principal, input))
      ),

    deleteConnector: ({ connectorId }) =>
      guarded(() => connectors.remove(principal, { connectorId })),

    grantSecret: ({ agent, secretId }) =>
      guarded(async () =>
        admin.grantSecret(principal, {
          agentId: await agentIdOf(agent),
          secretId,
        })
      ),

    revokeApiKey: (input) =>
      guarded(async () => {
        const revoked = await admin.revokeApiKey(principal, input);
        return {
          id: revoked.id,
          name: revoked.name,
          revokedAt: revoked.revokedAt,
        };
      }),

    revokeSecret: ({ agent, secretId }) =>
      guarded(async () =>
        admin.revokeSecret(principal, {
          agentId: await agentIdOf(agent),
          secretId,
        })
      ),

    updateAgent: ({ agent, ...patch }) =>
      guarded(async () =>
        toAgentInfo(
          await admin.updateAgent(principal, {
            ...patch,
            agentId: await agentIdOf(agent),
          })
        )
      ),
  };
};
