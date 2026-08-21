import Anthropic from "@anthropic-ai/sdk";
import type { Db } from "#/db/client";
import { anthropicKeyFor } from "./service";

/**
 * The Vaults half of the Managed Agents surface, behind one interface for the
 * same reason as `gateway.ts`: nothing outside this module imports the SDK.
 * Connectors consume `VaultGateway`, so the beta API can move without the
 * connector module noticing.
 *
 * Every payload shape here is copied from the Phase 4 entry spike
 * (`scripts/anthropic-spike.ts vaults`), which ran against the live API.
 */

export interface CreateVaultInput {
  connectorId: string;
  displayName: string;
}

export interface BearerCredentialInput {
  connectorId: string;
  displayName: string;
  mcpServerUrl: string;
  token: string;
  vaultId: string;
}

/**
 * `refresh` is present only when the server granted a refresh token - that
 * block is what Anthropic uses to keep the credential alive on its own, and a
 * grant without one simply works until it expires.
 */
export interface OAuthRefreshInput {
  clientId: string;
  clientSecret: string | null;
  refreshToken: string;
  scope: string | null;
  tokenEndpoint: string;
  tokenEndpointAuth: "none" | "client_secret_basic" | "client_secret_post";
}

export interface OAuthCredentialInput {
  accessToken: string;
  connectorId: string;
  displayName: string;
  expiresAt: Date;
  mcpServerUrl: string;
  refresh: OAuthRefreshInput | null;
  vaultId: string;
}

/** A re-authorization: secrets only. `mcp_server_url` is immutable. */
export interface UpdateOAuthSecretsInput {
  accessToken: string;
  credentialId: string;
  expiresAt: Date;
  refreshToken: string | null;
  vaultId: string;
}

export interface VaultGateway {
  createBearerCredential: (input: BearerCredentialInput) => Promise<string>;
  createOAuthCredential: (input: OAuthCredentialInput) => Promise<string>;
  createVault: (input: CreateVaultInput) => Promise<string>;
  /**
   * Removing a connector. The spike confirmed a vault holding live credentials
   * deletes in one call - no archive step - and that this touches nothing else.
   */
  deleteVault: (vaultId: string) => Promise<void>;
  updateOAuthSecrets: (input: UpdateOAuthSecretsInput) => Promise<void>;
}

const refreshBlock = (refresh: OAuthRefreshInput) => ({
  client_id: refresh.clientId,
  refresh_token: refresh.refreshToken,
  token_endpoint: refresh.tokenEndpoint,
  token_endpoint_auth:
    refresh.tokenEndpointAuth === "none"
      ? { type: "none" as const }
      : {
          client_secret: refresh.clientSecret ?? "",
          type: refresh.tokenEndpointAuth,
        },
  ...(refresh.scope ? { scope: refresh.scope } : {}),
});

export const createVaultGateway = (client: Anthropic): VaultGateway => ({
  async createBearerCredential(input) {
    const credential = await client.beta.vaults.credentials.create(
      input.vaultId,
      {
        auth: {
          mcp_server_url: input.mcpServerUrl,
          token: input.token,
          type: "static_bearer",
        },
        display_name: input.displayName,
        metadata: { connector_id: input.connectorId },
      }
    );
    return credential.id;
  },

  async createOAuthCredential(input) {
    const credential = await client.beta.vaults.credentials.create(
      input.vaultId,
      {
        auth: {
          access_token: input.accessToken,
          expires_at: input.expiresAt.toISOString(),
          mcp_server_url: input.mcpServerUrl,
          type: "mcp_oauth",
          ...(input.refresh ? { refresh: refreshBlock(input.refresh) } : {}),
        },
        display_name: input.displayName,
        metadata: { connector_id: input.connectorId },
      }
    );
    return credential.id;
  },

  async createVault(input) {
    const vault = await client.beta.vaults.create({
      display_name: input.displayName,
      metadata: { connector_id: input.connectorId },
    });
    return vault.id;
  },

  async deleteVault(vaultId) {
    await client.beta.vaults.delete(vaultId);
  },

  async updateOAuthSecrets(input) {
    // A partial `auth` patch: the spike confirmed the omitted refresh fields
    // (client_id, token_endpoint, …) are preserved rather than cleared.
    await client.beta.vaults.credentials.update(input.credentialId, {
      auth: {
        access_token: input.accessToken,
        expires_at: input.expiresAt.toISOString(),
        type: "mcp_oauth",
        ...(input.refreshToken
          ? { refresh: { refresh_token: input.refreshToken } }
          : {}),
      },
      vault_id: input.vaultId,
    });
  },
});

/**
 * Null when the Anthropic integration is off for this workspace - the same
 * contract as `createGateway`, and on the same key. A connector added with no
 * key is still recorded and still lists its tools; it just has no vault yet,
 * exactly as an agent added with no key stays `unregistered`.
 */
export const createVaults = async (
  db: Db,
  env: Env,
  workspaceId: string
): Promise<VaultGateway | null> => {
  const resolved = await anthropicKeyFor(db, env, workspaceId);
  return resolved
    ? createVaultGateway(new Anthropic({ apiKey: resolved.apiKey }))
    : null;
};
