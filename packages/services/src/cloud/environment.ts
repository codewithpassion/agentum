/**
 * Where a cloud agent's code runs. "isolate" is the default: skill scripts run
 * in a short-lived Dynamic Worker and Pi's file tools work on the library.
 * "linux-vm" gives the session a Linux VM (a Sandbox SDK container). This module
 * imports nothing, so the web app can import it for the form.
 */

export const CLOUD_ENVIRONMENTS = [
  {
    description:
      "Starts in milliseconds and costs almost nothing. No shell, and scripts see only their own skill files.",
    id: "isolate",
    label: "Isolate",
  },
  {
    description:
      "A real Linux machine with a shell, bun and node. It takes a few seconds to start and is billed while it runs.",
    id: "linux-vm",
    label: "Linux VM",
  },
] as const;

export type CloudEnvironment = (typeof CLOUD_ENVIRONMENTS)[number]["id"];

export const CLOUD_DEFAULT_ENVIRONMENT: CloudEnvironment = "isolate";

/** The key in an agent's `runtimeConfig`. */
export const CLOUD_ENVIRONMENT_KEY = "environment";

export const isCloudEnvironment = (value: unknown): value is CloudEnvironment =>
  CLOUD_ENVIRONMENTS.some((entry) => entry.id === value);

/** The environment an agent's `runtimeConfig` asks for. A missing or unknown value is the default. */
export const cloudEnvironmentOf = (
  runtimeConfig: Record<string, unknown>
): CloudEnvironment => {
  const value = runtimeConfig[CLOUD_ENVIRONMENT_KEY];
  return isCloudEnvironment(value) ? value : CLOUD_DEFAULT_ENVIRONMENT;
};

/** A message naming the valid environments when `runtimeConfig` holds an invalid one, undefined otherwise. */
export const cloudEnvironmentError = (
  runtimeConfig: Record<string, unknown>
): string | undefined => {
  const value = runtimeConfig[CLOUD_ENVIRONMENT_KEY];
  if (value === undefined || isCloudEnvironment(value)) {
    return;
  }
  const valid = CLOUD_ENVIRONMENTS.map((entry) => `"${entry.id}"`).join(", ");
  return `Unknown environment. Valid cloud environments: ${valid}.`;
};
