/**
 * MCP management (X.10, MA.1) delegates to the UI services. Agent writes
 * admit write OAuth connections and write/admin keys; setup requires an
 * admin key. Audits name the key or OAuth client and user, never credentials.
 */
import type { ApiKeyAccess } from "@repo/db/shared";
import { MAX_TURNS_KEY } from "@repo/protocol/safeguards";
import {
  type AgentManager,
  type KeyLevel,
  type KeyPrincipal,
  requireAgentManager,
  requireKey,
} from "./admin-access.ts";
import type {
  AgentProfileService,
  SetAskBeforeInput,
} from "./agent-profile.ts";
import type { AgentOwnersInput, AgentRecord, AgentsService } from "./agents.ts";
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
  agentProfile,
  mailDomain,
  apiKeys,
  connectors,
  events,
  inbox,
  machines,
  secrets,
}: {
  agents: AgentsService;
  agentProfile?: AgentProfileService;
  mailDomain?: string;
  apiKeys: ApiKeysService;
  connectors: ConnectorsService;
  events: EventsService;
  inbox: InboxService;
  machines: MachinesService;
  secrets: SecretsService;
}) => {
  /** One `admin.action` event naming the key, OAuth client or browser user. `details` hold ids and names, never values. */
  const record = async (
    key: AgentManager,
    tool: string,
    details: Details,
    agentId?: string
  ): Promise<void> => {
    await events.append({
      actor:
        key.via === "api_key"
          ? { id: key.apiKey.id, kind: "api_key" }
          : { id: key.userId, kind: "user" },
      agentId,
      payload: {
        ...details,
        ...(key.via === "oauth" ? { clientId: key.oauthClient.clientId } : {}),
        ...(key.via === "api_key"
          ? { keyId: key.apiKey.id, keyName: key.apiKey.name ?? null }
          : {}),
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

  const secretManager = (principal: Principal, tool: string): AgentManager => {
    if (
      principal.kind === "user" &&
      principal.via === "session" &&
      principal.isAdmin
    ) {
      return principal as AgentManager;
    }
    return checked(principal, tool, "admin");
  };

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
    const key = requireAgentManager(principal, "admin.create_agent");
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
    const key = requireAgentManager(principal, "admin.update_agent");
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

  const profileService = () => {
    if (!agentProfile) {
      throw new ServiceError(
        "invalid",
        "Agent profiles are not available here"
      );
    }
    return agentProfile;
  };

  const getAgent = async (principal: Principal, agentId: string) => {
    const agent = await agents.get(principal, agentId);
    const [profile, askBefore, updates] = await Promise.all([
      profileService().details(principal, { agentId }),
      profileService().askBefore(principal, { agentId }),
      events.list(principal, {
        agentId,
        limit: 1,
        types: [
          "agent.created",
          "agent.updated",
          "agent.address_reserved",
          "admin.action",
          "tool_rule.changed",
          "skill.assigned",
          "skill.unassigned",
        ],
      }),
    ]);
    return {
      ...agent,
      askBefore,
      connectors: profile.connectors,
      emailAddress:
        agent.emailLocal && mailDomain
          ? `${agent.emailLocal}@${mailDomain}`
          : null,
      machine: profile.machine,
      skills: profile.skills,
      updatedAt: updates.entries[0]?.createdAt ?? agent.createdAt,
    };
  };

  const archiveAgent = async (principal: Principal, agentId: string) => {
    const caller = requireAgentManager(principal, "admin.archive_agent");
    const agent = await agents.archive(principal, agentId);
    await record(caller, "archive_agent", {}, agentId);
    return agent;
  };

  const restoreAgent = async (principal: Principal, agentId: string) => {
    const caller = requireAgentManager(principal, "admin.restore_agent");
    const agent = await agents.restore(principal, agentId);
    await record(caller, "restore_agent", {}, agentId);
    return agent;
  };

  const setAgentOwners = async (
    principal: Principal,
    agentId: string,
    input: Partial<AgentOwnersInput>
  ) => {
    const caller = requireAgentManager(principal, "admin.set_agent_owners");
    const current = await agents.get(principal, agentId);
    const agent = await agents.setOwners(principal, agentId, {
      backupUserId:
        input.backupUserId === undefined
          ? current.backupUserId
          : input.backupUserId,
      ownerUserId:
        input.ownerUserId === undefined
          ? current.ownerUserId
          : input.ownerUserId,
    });
    await record(
      caller,
      "set_agent_owners",
      { backupUserId: agent.backupUserId, ownerUserId: agent.ownerUserId },
      agentId
    );
    return agent;
  };

  const setAgentAskBefore = async (
    principal: Principal,
    input: SetAskBeforeInput
  ) => {
    const caller = requireAgentManager(principal, "admin.set_agent_ask_before");
    await profileService().setAskBefore(principal, input);
    await record(
      caller,
      "set_agent_ask_before",
      { action: input.action, ask: input.ask },
      input.agentId
    );
  };

  const checkAgentAddress = async (principal: Principal, local: string) => {
    requireAgentManager(principal, "admin.check_agent_address");
    return await agents.checkAddress(principal, local);
  };

  const reserveAgentAddress = async (
    principal: Principal,
    agentId: string,
    local: string
  ) => {
    const caller = requireAgentManager(
      principal,
      "admin.reserve_agent_address"
    );
    const agent = await agents.reserveAddress(principal, agentId, local);
    await record(
      caller,
      "reserve_agent_address",
      { emailLocal: local },
      agentId
    );
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
    const key = secretManager(principal, "grant_secret");
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
    const key = secretManager(principal, "revoke_secret");
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
    const key =
      principal.kind === "user" && principal.via === "session"
        ? requireAgentManager(principal, "admin.create_inbox_thread")
        : checked(principal, "create_inbox_thread", "write");
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
    archiveAgent,
    audit,
    checkAgentAddress,
    createAgent,
    createApiKey,
    createEnrolmentCode,
    createInboxThread,
    createSecret,
    getAgent,
    grantSecret,
    reserveAgentAddress,
    restoreAgent,
    revokeApiKey,
    revokeSecret,
    setAgentAskBefore,
    setAgentOwners,
    updateAgent,
  };
};

export type AdminService = ReturnType<typeof createAdminService>;
