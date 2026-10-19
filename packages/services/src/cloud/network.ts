/**
 * Whether a cloud agent's session may reach the network. Agents with no
 * setting keep network access, so the setting is only written when it is
 * turned off. This module imports nothing, so the web app can import it for
 * the form.
 */

/** The key in an agent's `runtimeConfig`. */
export const CLOUD_NETWORK_KEY = "networkAccess";

/** The network access an agent's `runtimeConfig` asks for. Only an explicit false turns it off. */
export const networkAccessOf = (
  runtimeConfig: Record<string, unknown>
): boolean => runtimeConfig[CLOUD_NETWORK_KEY] !== false;

/** A message when `runtimeConfig` holds a network setting that is not a boolean, undefined otherwise. */
export const networkAccessError = (
  runtimeConfig: Record<string, unknown>
): string | undefined => {
  const value = runtimeConfig[CLOUD_NETWORK_KEY];
  if (value === undefined || typeof value === "boolean") {
    return;
  }
  return "Network access must be true or false.";
};
