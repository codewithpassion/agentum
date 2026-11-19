import type { AgentKeys } from "@repo/db/shared";
import { z } from "zod";
import { authorize } from "./authz.ts";
import { readableWorkspace } from "./guards.ts";
import type { Principal } from "./workspaces.ts";

const KEYS_READ = "keys.read";
const KEYS_KIND = "keys";

export const forAgentInputSchema = z.strictObject({
  agentId: z.string().min(1),
});

/**
 * Stub: an agent with no apps, address, secrets or connections, asking at the
 * default level. The Keys service task reads the real rows.
 */
const emptyKeys = (): AgentKeys => ({
  apps: [],
  asksBefore: { level: "rarely", overrides: [] },
  identity: { emailAddress: null, slackApp: null },
  otherAgents: { connections: [], handsTo: [] },
  secrets: [],
});

export const createKeysService = () => {
  const forAgent = (
    principal: Principal,
    agentId: string
  ): Promise<AgentKeys> => {
    const workspaceId = readableWorkspace(principal, KEYS_READ);
    authorize(principal, KEYS_READ, {
      id: agentId,
      kind: KEYS_KIND,
      workspaceId,
    });
    return Promise.resolve(emptyKeys());
  };

  return { forAgent };
};

export type KeysService = ReturnType<typeof createKeysService>;
