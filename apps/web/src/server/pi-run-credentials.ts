import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { MODEL_PROVIDERS, type ModelProvider } from "@repo/db/shared";
import { NO_KEY_MESSAGE } from "@repo/services/managed/keys";
import { NO_KEY_MESSAGES } from "@repo/services/model-keys";

export type KeyProvider = "anthropic" | ModelProvider;

const READ_ONLY_MESSAGE =
  "Provider keys are managed in Settings and cannot be changed from a run.";

const NO_KEY_BY_PROVIDER: Record<KeyProvider, string> = {
  anthropic: NO_KEY_MESSAGE,
  ...NO_KEY_MESSAGES,
};

function isKeyProvider(providerId: string): providerId is KeyProvider {
  return (
    providerId === "anthropic" ||
    MODEL_PROVIDERS.some((provider) => provider === providerId)
  );
}

/**
 * Read-only store that hands the workspace's provider keys to Pi. A key is
 * resolved on every read, so a rotated key applies to the next request, and
 * it is never kept in this object or in Durable Object storage.
 */
export function workspaceKeyStore(
  resolveKey: (provider: KeyProvider) => Promise<string | null>
): CredentialStore {
  return {
    delete: () => Promise.reject(new Error(READ_ONLY_MESSAGE)),
    list: () => Promise.resolve([]),
    modify: () => Promise.reject(new Error(READ_ONLY_MESSAGE)),
    read: async (providerId: string): Promise<Credential | undefined> => {
      if (!isKeyProvider(providerId)) {
        return;
      }
      const key = await resolveKey(providerId);
      if (key === null) {
        throw new Error(NO_KEY_BY_PROVIDER[providerId]);
      }
      return { key, type: "api_key" };
    },
  };
}
