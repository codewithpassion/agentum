/**
 * The key-authenticated admin API (X.10): setup that was UI-only, for an
 * `hm_key_` key. Each method checks the key, calls the service the UI uses and
 * writes one `admin.action` event naming the key (id and name) as the actor.
 *
 * Creating agents and inbox threads takes a `write` key. Everything else
 * needs an `admin` key. No payload carries a secret value, a minted key or an
 * enrolment code: events name ids, names and hosts only.
 */
import type { ApiKeyAccess } from "@repo/db/shared";
import { MAX_TURNS_KEY } from "@repo/protocol/safeguards";
import {
  type KeyLevel,
  type KeyPrincipal,
  requireKey,
} from "./admin-access.ts";
import type { AgentRecord, AgentsService } from "./agents.ts";
import type { ApiKeySummary, ApiKeysService } from "./api-keys.ts";
import type { CloudEnvironment } from "./cloud/environment.ts";
import { CLOUD_ENVIRONMENT_KEY } from "./cloud/environment.ts";
import { CLOUD_NETWORK_KEY } from "./cloud/network.ts";
import type { ConnectorsService } from "./connectors.ts";
import { ServiceError } from "./errors.ts";
import type { EventsService } from "./events.ts";
import type { InboxService, ThreadRecord } from "./inbox.ts";
import type { MachinesService } from "./machines.ts";
import type {
  SecretCreateInput,
  SecretSummary,
  SecretsService,
} from "./secrets.ts";
import type { Principal } from "./workspaces.ts";

/** What create_agent takes. Environment, network and turn limit are the agent's `runtimeConfig`. */
export interface AdminAgentCreate {
  connectors?: string[];
  environment?: CloudEnvironment;
  instructions?: string;
  machineId?: string;
  maxTurns?: number;
  model: string;
  name: string;
  networkAccess?: boolean;
  runtime: AgentRecord["runtime"];
  slug?: string;
}

/** What update_agent takes. The runtime cannot change. `connectors` are added, none are removed. */
export interface AdminAgentUpdate {
  agentId: string;
  connectors?: string[];
  environment?: CloudEnvironment;
  instructions?: string;
  machineId?: string | null;
  maxTurns?: number;
  model?: string;
  name?: string;
  networkAccess?: boolean;
  slug?: string;
}

export interface AdminKeyCreate {
  access: ApiKeyAccess;
  name: string;
}

export interface AdminEnrolmentCode {
  code: string;
  expiresAt: string;
}

type Details = Record<string, string | number | boolean | string[] | null>;

export const createAdminService = ({
  agents,
  apiKeys,
  connectors,
  events,
  inbox,
  machines,
  secrets,
}: {
  agents: AgentsService;
  apiKeys: ApiKeysService;
  connectors: ConnectorsService;
  events: EventsService;
  inbox: InboxService;
  machines: MachinesService;
  secrets: SecretsService;
}) => {
  /** One `admin.action` event, the key as the actor. `details` hold ids and names, never values. */
  const record = async (
    key: KeyPrincipal,
    tool: string,
    details: Details,
    agentId?: string
  ): Promise<void> => {
    await events.append({
      actor: { id: key.apiKey.id, kind: "api_key" },
      agentId,
      payload: {
        ...details,
        keyId: key.apiKey.id,
        keyName: key.apiKey.name ?? null,
        tool,
        userId: key.userId,
      },
      type: "admin.action",
      workspaceId: key.workspaceId,
    });
  };

  const checked = (
    principal: Principal,
    tool: string,
    level: KeyLevel
  ): KeyPrincipal => requireKey(principal, `admin.${tool}`, level);

  /** Writes the audit event for a call another path already made, such as assign_skill. */
  const audit = async (
    principal: Principal,
    tool: string,
    details: Details,
    agentId?: string
  ): Promise<void> => {
    if (
      principal.kind === "user" &&
      principal.via === "api_key" &&
      principal.apiKey
    ) {
      await record(principal as KeyPrincipal, tool, details, agentId);
    }
  };

  const runtimeSettings = (
    input: Pick<AdminAgentCreate, "environment" | "maxTurns" | "networkAccess">
  ): Record<string, boolean | number | string> => ({
    ...(input.environment === undefined
      ? {}
      : { [CLOUD_ENVIRONMENT_KEY]: input.environment }),
    ...(input.maxTurns === undefined
      ? {}
      : { [MAX_TURNS_KEY]: input.maxTurns }),
    ...(input.networkAccess === undefined
      ? {}
      : { [CLOUD_NETWORK_KEY]: input.networkAccess }),
  });

  const assignConnectors = async (
    principal: Principal,
    agentId: string,
    connectorIds: readonly string[] | undefined
  ): Promise<void> => {
    if (!connectorIds?.length) {
      return;
    }
    // A connector the agent has keeps its credential mode: assigning again would reset it.
    const held = new Set(
      (await connectors.assignments(principal, { agentId })).map(
        (assignment) => assignment.connectorId
      )
    );
    for (const connectorId of connectorIds) {
      if (!held.has(connectorId)) {
        // biome-ignore lint/performance/noAwaitInLoops: One assignment at a time keeps the first failure clear.
        await connectors.assign(principal, { agentId, connectorId });
      }
    }
  };

  const createAgent = async (
    principal: Principal,
    input: AdminAgentCreate
  ): Promise<AgentRecord> => {
    const key = checked(principal, "create_agent", "write");
    // Fail before the agent exists, so a retry does not make a second one.
    await connectors.assertExist(principal, input.connectors ?? []);
    const agent = await agents.create(principal, {
      instructions: input.instructions,
      machineId: input.machineId,
      model: input.model,
      name: input.name,
      runtime: input.runtime,
      runtimeConfig: runtimeSettings(input),
      slug: input.slug,
    });
    await record(
      key,
      "create_agent",
      {
        agentId: agent.id,
        connectors: input.connectors ?? [],
        name: agent.name,
        runtime: agent.runtime,
      },
      agent.id
    );
    await assignConnectors(principal, agent.id, input.connectors);
    return agent;
  };

  const updateAgent = async (
    principal: Principal,
    input: AdminAgentUpdate
  ): Promise<AgentRecord> => {
    const key = checked(principal, "update_agent", "write");
    await connectors.assertExist(principal, input.connectors ?? []);
    const {
      agentId,
      connectors: connectorIds,
      environment,
      maxTurns,
      networkAccess,
      ...fields
    } = input;
    const settings = runtimeSettings({ environment, maxTurns, networkAccess });
    // Refused before anything is saved, so no field changes and no event is written.
    if ((await agents.get(principal, agentId)).status === "archived") {
      throw new ServiceError("invalid", "That agent is archived");
    }
    const agent = await agents.update(
      principal,
      agentId,
      fields,
      Object.keys(settings).length === 0
        ? undefined
        : { runtimeConfigPatch: settings }
    );
    await record(
      key,
      "update_agent",
      {
        agentId,
        changed: [
          ...Object.keys(fields),
          ...Object.keys(settings),
          ...(connectorIds?.length ? ["connectors"] : []),
        ],
        connectors: connectorIds ?? [],
        name: agent.name,
      },
      agentId
    );
    await assignConnectors(principal, agentId, connectorIds);
    return agent;
  };

  const createSecret = async (
    principal: Principal,
    input: SecretCreateInput
  ): Promise<SecretSummary> => {
    const key = checked(principal, "create_secret", "admin");
    const secret = await secrets.create(principal, input);
    await record(key, "create_secret", {
      hosts:
        secret.mode === "proxy"
          ? secret.rules.map((rule) => rule.host)
          : secret.allowedHosts,
      mode: secret.mode,
      name: secret.name,
      secretId: secret.id,
    });
    return secret;
  };

  const grantSecret = async (
    principal: Principal,
    input: { agentId: string; secretId: string }
  ): Promise<void> => {
    const key = checked(principal, "grant_secret", "admin");
    await secrets.grant(principal, input.agentId, input.secretId);
    await record(
      key,
      "grant_secret",
      { secretId: input.secretId },
      input.agentId
    );
  };

  const revokeSecret = async (
    principal: Principal,
    input: { agentId: string; secretId: string }
  ): Promise<void> => {
    const key = checked(principal, "revoke_secret", "admin");
    await secrets.revoke(principal, input.agentId, input.secretId);
    await record(
      key,
      "revoke_secret",
      { secretId: input.secretId },
      input.agentId
    );
  };

  const createInboxThread = async (
    principal: Principal,
    input: { title: string }
  ): Promise<ThreadRecord> => {
    const key = checked(principal, "create_inbox_thread", "write");
    const thread = await inbox.createThread(principal, input);
    await record(key, "create_inbox_thread", {
      name: thread.title,
      threadId: thread.id,
    });
    return thread;
  };

  const createEnrolmentCode = async (
    principal: Principal,
    input: Parameters<MachinesService["createEnrollToken"]>[1]
  ): Promise<AdminEnrolmentCode> => {
    const key = checked(principal, "create_enrolment_code", "admin");
    const issued = await machines.createEnrollToken(principal, input);
    await record(key, "create_enrolment_code", {
      expiresAt: issued.expiresAt,
      machineId: input.machineId ?? null,
      name: input.machineName ?? null,
      role: input.role ?? "agent_host",
    });
    return issued;
  };

  const createApiKey = async (
    principal: Principal,
    input: AdminKeyCreate
  ): Promise<{ key: ApiKeySummary; secret: string }> => {
    const caller = checked(principal, "create_api_key", "admin");
    const created = await apiKeys.create(principal, input);
    await record(caller, "create_api_key", {
      access: created.key.access,
      keyIdCreated: created.key.id,
      name: created.key.name,
    });
    return created;
  };

  const revokeApiKey = async (
    principal: Principal,
    input: { keyId: string }
  ): Promise<ApiKeySummary> => {
    const caller = checked(principal, "revoke_api_key", "admin");
    const revoked = await apiKeys.revoke(principal, input.keyId);
    await record(caller, "revoke_api_key", {
      keyIdRevoked: revoked.id,
      name: revoked.name,
    });
    return revoked;
  };

  return {
    audit,
    createAgent,
    createApiKey,
    createEnrolmentCode,
    createInboxThread,
    createSecret,
    grantSecret,
    revokeApiKey,
    revokeSecret,
    updateAgent,
  };
};

export type AdminService = ReturnType<typeof createAdminService>;
