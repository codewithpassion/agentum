import type { Credential, CredentialStore } from "@earendil-works/pi-ai";

export const NO_KEY_MESSAGE =
  "This workspace has no Anthropic API key. Add one in Settings, Managed Agents.";

const READ_ONLY_MESSAGE =
  "The Anthropic key is managed in Settings and cannot be changed from a run.";

/**
 * Read-only store that hands the workspace's Anthropic key to Pi. The key is
 * resolved on every read, so a rotated key applies to the next request, and
 * it is never kept in this object or in Durable Object storage.
 */
export function workspaceKeyStore(
  resolveKey: () => Promise<string | null>
): CredentialStore {
  return {
    delete: () => Promise.reject(new Error(READ_ONLY_MESSAGE)),
    list: () => Promise.resolve([]),
    modify: () => Promise.reject(new Error(READ_ONLY_MESSAGE)),
    read: async (providerId: string): Promise<Credential | undefined> => {
      if (providerId !== "anthropic") {
        return;
      }
      const key = await resolveKey();
      if (key === null) {
        throw new Error(NO_KEY_MESSAGE);
      }
      return { key, type: "api_key" };
    },
  };
}
