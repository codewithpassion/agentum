import Anthropic from "@anthropic-ai/sdk";
import type { Db } from "#/db/client";
import { anthropicKeyFor } from "./service";

/**
 * The Vaults half of the Managed Agents surface, behind one interface for the
 * same reason as `gateway.ts`: nothing outside this module imports the SDK.
 * Connectors consume `VaultGateway` and the workspace-secrets mirror consumes
 * `SecretVaultGateway`, so the beta API can move without either module
 * noticing - and each fake in a test covers only the half its caller uses.
 *
 * Every payload shape here is copied from an entry spike that ran against the
 * live API: `scripts/anthropic-spike.ts vaults` for the connector credentials,
 * `… secrets` for the `environment_variable` ones.
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

/**
 * Anthropic's cap on the live credentials one vault holds. The 21st create
 * fails with a bare "The request was invalid" (Phase 5 entry spike), so the
 * workspace-secrets mirror counts its own rows and says something useful
 * instead of forwarding that.
 */
export const MAX_VAULT_CREDENTIALS = 20;

export interface CreateSecretsVaultInput {
  displayName: string;
  workspaceId: string;
}

export interface EnvVarCredentialInput {
  /** At most 16 entries, and a replacement rather than a merge on update. */
  allowedHosts: string[];
  displayName: string;
  /** Metadata only, so a credential can be traced back to its row. */
  secretId: string;
  /** The environment variable's name. Immutable after create. */
  secretName: string;
  value: string;
  vaultId: string;
}

/**
 * `secret_name` is not an update field at all, which costs nothing: a secret's
 * name is immutable here too, so the only two updates are a rotated value and an
 * edited host list.
 */
export interface UpdateEnvVarCredentialInput {
  allowedHosts: string[];
  credentialId: string;
  value: string;
  vaultId: string;
}

export interface ArchiveCredentialInput {
  credentialId: string;
  vaultId: string;
}

/**
 * The `environment_variable` half of the surface: everything the workspace
 * secrets mirror needs, and the only part of it `modules/secrets` ever sees.
 *
 * `deleteVault` is borrowed rather than redeclared - a workspace's secrets vault
 * goes the way a connector's does, in one call.
 */
export interface SecretVaultGateway extends Pick<VaultGateway, "deleteVault"> {
  archiveCredential: (input: ArchiveCredentialInput) => Promise<void>;
  createEnvVarCredential: (input: EnvVarCredentialInput) => Promise<string>;
  createSecretsVault: (input: CreateSecretsVaultInput) => Promise<string>;
  updateEnvVarCredential: (input: UpdateEnvVarCredentialInput) => Promise<void>;
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

/**
 * Header substitution only, on every create and every update.
 *
 * `injection_location` defaults to `{ body: true, header: true }` when omitted
 * (Phase 5 entry spike), and body substitution is the one thing the plan refuses
 * to allow: a value spliced into request bodies is a value the sandbox can
 * exfiltrate by asking any allowed host to echo its body back. `body: false` is
 * written out rather than left to the default so the invariant holds whether an
 * update patches this field or replaces it.
 */
const HEADER_ONLY = { body: false, header: true } as const;

const limitedTo = (allowedHosts: readonly string[]) => ({
  allowed_hosts: [...allowedHosts],
  type: "limited" as const,
});

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

export const createVaultGateway = (
  client: Anthropic
): SecretVaultGateway & VaultGateway => ({
  async archiveCredential(input) {
    // Archive rather than delete: it frees the `secret_name` for reuse in the
    // same vault (spike), which is what makes delete-then-recreate work.
    await client.beta.vaults.credentials.archive(input.credentialId, {
      vault_id: input.vaultId,
    });
  },

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

  async createEnvVarCredential(input) {
    const credential = await client.beta.vaults.credentials.create(
      input.vaultId,
      {
        auth: {
          injection_location: HEADER_ONLY,
          networking: limitedTo(input.allowedHosts),
          secret_name: input.secretName,
          secret_value: input.value,
          type: "environment_variable",
        },
        display_name: input.displayName,
        metadata: { secret_id: input.secretId },
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

  async createSecretsVault(input) {
    const vault = await client.beta.vaults.create({
      display_name: input.displayName,
      metadata: { workspace_id: input.workspaceId },
    });
    return vault.id;
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

  async updateEnvVarCredential(input) {
    // The whole allowlist goes every time: a `networking` update replaces
    // `allowed_hosts` rather than merging into it (spike). The value rides along
    // because the mirror holds it anyway, which makes a rotation and a host edit
    // the same single call.
    await client.beta.vaults.credentials.update(input.credentialId, {
      auth: {
        injection_location: HEADER_ONLY,
        networking: limitedTo(input.allowedHosts),
        secret_value: input.value,
        type: "environment_variable",
      },
      vault_id: input.vaultId,
    });
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
): Promise<(SecretVaultGateway & VaultGateway) | null> => {
  const resolved = await anthropicKeyFor(db, env, workspaceId);
  return resolved
    ? createVaultGateway(new Anthropic({ apiKey: resolved.apiKey }))
    : null;
};
