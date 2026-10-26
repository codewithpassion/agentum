import { cloudEnvironmentOf } from "@repo/services/cloud/environment";
import { networkAccessOf } from "@repo/services/cloud/network";
import { hostsOf } from "./grants.ts";

export interface SecretStatus {
  text: string;
  works: boolean;
}

/**
 * Whether a granted secret reaches a run of this agent, and how. Null for
 * machine and managed agents and for Linux VM agents, where env secrets are
 * plain environment variables and need no explanation.
 */
export const secretStatus = (
  secret: {
    allowedHosts: readonly string[];
    mode: string;
    rules: readonly { host: string }[];
  },
  agent: { runtime: string; runtimeConfig: Record<string, unknown> }
): SecretStatus | null => {
  if (
    agent.runtime !== "cloud" ||
    cloudEnvironmentOf(agent.runtimeConfig) !== "isolate"
  ) {
    return null;
  }
  if (secret.mode === "proxy") {
    return {
      text: `proxy: added for ${hostsOf(secret.rules).join(", ")}`,
      works: true,
    };
  }
  if (!networkAccessOf(agent.runtimeConfig)) {
    return {
      text: "env: network access is off, won't work here",
      works: false,
    };
  }
  if (secret.allowedHosts.length === 0) {
    return { text: "env: no allowed hosts, won't work here", works: false };
  }
  return {
    text: `env: placeholder, allowed hosts ${secret.allowedHosts.join(", ")}`,
    works: true,
  };
};
