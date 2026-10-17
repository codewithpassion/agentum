import {
  type CredentialStore,
  createModels,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";

/**
 * The auth context reports no env vars and no files, so an `ANTHROPIC_API_KEY`
 * in the Worker's environment never reaches a cloud run. The workspace key is
 * the only auth source.
 */
export function createCloudModels(credentials: CredentialStore): MutableModels {
  const models = createModels({
    authContext: {
      env: async () => undefined,
      fileExists: async () => false,
    },
    credentials,
  });
  models.setProvider(anthropicProvider());
  return models;
}
