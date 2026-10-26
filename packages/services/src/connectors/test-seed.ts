/**
 * Test helpers: connectors, assignments and credentials written straight to
 * the tables, so a test can start from any state without pasting or OAuth.
 * Imported by tests only, never by the Worker.
 */
import type { Database } from "@repo/db";
import {
  agentConnectors,
  connectors,
  credentials,
} from "@repo/db/schema/connectors";
import type {
  ConnectorAuthKind,
  CredentialMode,
  CredentialOwnerKind,
  CredentialStatus,
} from "@repo/db/shared";
import { ulid } from "ulidx";
import { encryptSecret } from "../crypto.ts";
import type { OAuthConfig } from "./oauth-config.ts";

/** An OAuth config whose token endpoint is `<origin>/token` (the stub's). */
export const testOAuthConfig = (origin: string): OAuthConfig => ({
  authorizationEndpoint: `${origin}/authorize`,
  client: {
    clientId: "client-1",
    clientSecret: null,
    redirectUri: null,
    source: "manual",
    tokenEndpointAuth: "none",
  },
  registrationEndpoint: null,
  resource: `${origin}/mcp`,
  scope: null,
  tokenEndpoint: `${origin}/token`,
  tokenEndpointAuthMethods: ["none"],
});

export const seedConnector = async (
  db: Database,
  input: {
    authKind: ConnectorAuthKind;
    headerName?: string | null;
    id: string;
    name?: string;
    now: string;
    oauth?: OAuthConfig | null;
    url?: string;
    workspaceId: string;
  }
): Promise<void> => {
  await db.insert(connectors).values({
    authKind: input.authKind,
    createdAt: input.now,
    createdBy: "u_seed",
    headerName: input.headerName ?? null,
    id: input.id,
    name: input.name ?? input.id,
    oauth: input.oauth ? JSON.stringify(input.oauth) : null,
    status: "ok",
    url: input.url ?? `https://mcp.example.com/${input.id}`,
    workspaceId: input.workspaceId,
  });
};

export const seedAssignment = async (
  db: Database,
  input: {
    agentId: string;
    allowedTools?: string[] | null;
    connectorId: string;
    credentialMode?: CredentialMode;
    now: string;
    workspaceId: string;
  }
): Promise<void> => {
  await db.insert(agentConnectors).values({
    agentId: input.agentId,
    allowedTools: input.allowedTools
      ? JSON.stringify(input.allowedTools)
      : null,
    connectorId: input.connectorId,
    createdAt: input.now,
    credentialMode: input.credentialMode ?? "user_or_agent",
    workspaceId: input.workspaceId,
  });
};

/** `secret` is the plaintext: a header value, or the OAuth token pair as JSON. */
export const seedCredential = async (
  db: Database,
  key: CryptoKey,
  input: {
    connectorId: string;
    expiresAt?: string | null;
    id?: string;
    now: string;
    ownerId: string;
    ownerKind: CredentialOwnerKind;
    refreshingUntil?: string | null;
    secret: string;
    status?: CredentialStatus;
    version?: number;
    workspaceId: string;
  }
): Promise<string> => {
  const id = input.id ?? ulid();
  await db.insert(credentials).values({
    connectorId: input.connectorId,
    createdAt: input.now,
    createdBy: "u_seed",
    expiresAt: input.expiresAt ?? null,
    id,
    ownerId: input.ownerId,
    ownerKind: input.ownerKind,
    refreshingUntil: input.refreshingUntil ?? null,
    secret: await encryptSecret(
      key,
      {
        field: "secret",
        rowId: id,
        table: "credentials",
        workspaceId: input.workspaceId,
      },
      input.secret
    ),
    status: input.status ?? "ok",
    updatedAt: input.now,
    version: input.version ?? 1,
    workspaceId: input.workspaceId,
  });
  return id;
};
