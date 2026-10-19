import {
  MAX_TURNS_KEY,
  maxTurnsError,
  maxTurnsOf,
} from "@repo/protocol/safeguards";
import type { RuntimeConfig } from "@repo/services/agents";
import {
  CLOUD_ENVIRONMENT_KEY,
  type CloudEnvironment,
} from "@repo/services/cloud/environment";
import { CLOUD_NETWORK_KEY } from "@repo/services/cloud/network";
import type { AgentFormValues } from "#/components/agent/agent-form";

/** The turn limit as form input: the configured value, or "" to use the default. */
export const maxTurnsInputOf = (
  runtimeConfig: Record<string, unknown>
): string => {
  const present = runtimeConfig[MAX_TURNS_KEY] !== undefined;
  if (!present || maxTurnsError(runtimeConfig) !== undefined) {
    return "";
  }
  return String(maxTurnsOf(runtimeConfig));
};

/** The `runtimeConfig` to save for these form values, built on a copy of `base`. */
export const runtimeConfigOf = (
  base: RuntimeConfig,
  values: {
    environment: CloudEnvironment;
    maxTurns: string;
    networkAccess: boolean;
    runtime: AgentFormValues["runtime"];
  }
): RuntimeConfig => {
  const config: RuntimeConfig = { ...base };
  if (values.runtime === "cloud") {
    config[CLOUD_ENVIRONMENT_KEY] = values.environment;
    config[CLOUD_NETWORK_KEY] = values.networkAccess;
  }
  if (values.runtime === "cloud" || values.runtime === "machine") {
    if (values.maxTurns.trim() === "") {
      return Object.fromEntries(
        Object.entries(config).filter(([key]) => key !== MAX_TURNS_KEY)
      );
    }
    config[MAX_TURNS_KEY] = Number(values.maxTurns);
  }
  return config;
};
