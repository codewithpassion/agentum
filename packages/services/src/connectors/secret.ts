import type { Database } from "@repo/db";
import { secrets } from "@repo/db/schema/secrets";
import { and, eq } from "drizzle-orm";
import { decryptSecret } from "../crypto.ts";
import { ServiceError } from "../errors.ts";
import {
  isHeaderSafe,
  matchHost,
  storedRulesSchema,
} from "../secrets/rules.ts";

/** Rechecked for every call so removing an allowed host takes effect immediately. */
export const checkConnectorSecretHost = (
  secret: { allowedHosts: string; mode: "env" | "proxy"; rules: string },
  url: string
): void => {
  const host = new URL(url).hostname;
  const hosts: string[] =
    secret.mode === "proxy"
      ? storedRulesSchema
          .parse(JSON.parse(secret.rules))
          .map((rule) => rule.host)
      : JSON.parse(secret.allowedHosts);
  if (!hosts.some((pattern) => matchHost(pattern, host))) {
    throw new ServiceError(
      "invalid",
      `The host ${host} is not allowed by this secret. Add it to the secret in Settings, Secrets.`
    );
  }
};

/** Internal only: plaintext is held for this request and must never reach a router. */
export const readConnectorSecret = async (
  db: Database,
  key: CryptoKey,
  connector: {
    secretId: string | null;
    workspaceId: string;
    url: string;
    headerName: string | null;
    headerTemplate: string | null;
  }
) => {
  const [secret] = connector.secretId
    ? await db
        .select()
        .from(secrets)
        .where(
          and(
            eq(secrets.id, connector.secretId),
            eq(secrets.workspaceId, connector.workspaceId)
          )
        )
    : [];
  if (!secret) {
    throw new ServiceError(
      "invalid",
      "The connector's secret was removed. Ask an admin to link a secret in Settings, Connectors."
    );
  }
  checkConnectorSecretHost(secret, connector.url);
  const value = await decryptSecret(
    key,
    {
      field: "value",
      rowId: secret.id,
      table: "secrets",
      workspaceId: connector.workspaceId,
    },
    secret.valueEnc
  );
  if (!isHeaderSafe(value)) {
    throw new ServiceError(
      "invalid",
      "The connector's secret must be plain text on one line."
    );
  }
  return {
    header: {
      name: connector.headerName ?? "Authorization",
      redact: value,
      value: (connector.headerTemplate ?? "Bearer {value}").replace(
        "{value}",
        () => value
      ),
    },
    id: secret.id,
    version: secret.version,
  };
};
