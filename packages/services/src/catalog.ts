import type { Database } from "@repo/db";
import { connectors } from "@repo/db/schema/connectors";
import {
  type CatalogEntry,
  CONNECTOR_CALL_TIMEOUT_SECONDS,
} from "@repo/db/shared";
import { and, eq } from "drizzle-orm";
import { ulid } from "ulidx";
import { z } from "zod";
import { authorize } from "./authz.ts";
import { entries } from "./catalog/entries.ts";
import { canonicalizeConnectorUrl } from "./connectors/url.ts";
import { ServiceError } from "./errors.ts";
import { requireAdminSession } from "./guards.ts";
import type { Clock } from "./runs/types.ts";
import type { Principal } from "./workspaces.ts";

const CATALOG_ADD = "catalog.add";
const CATALOG_KIND = "catalog";

export const catalogAddInputSchema = z.strictObject({
  key: z.string().min(1),
});

export const createCatalogService = ({
  db,
  clock,
}: {
  db: Database;
  clock: Clock;
}) => {
  const list = (): CatalogEntry[] =>
    entries.map((entry) => ({
      ...entry,
      defaultAllowedTools: [...entry.defaultAllowedTools],
    }));

  /**
   * Defaults stay on the entry: allowed tools belong to agent assignments, and
   * KY.5 applies them there. A connector has no allow-list column.
   */
  const add = async (
    principal: Principal,
    key: string
  ): Promise<{ connectorId: string }> => {
    const user = requireAdminSession(principal, CATALOG_ADD);
    const { workspaceId } = user;
    authorize(user, CATALOG_ADD, { kind: CATALOG_KIND, workspaceId });
    const parsed = catalogAddInputSchema.parse({ key });
    const [existing] = await db
      .select({ id: connectors.id })
      .from(connectors)
      .where(
        and(
          eq(connectors.workspaceId, workspaceId),
          eq(connectors.catalogKey, parsed.key)
        )
      )
      .limit(1);
    if (existing) {
      return { connectorId: existing.id };
    }
    const entry = entries.find((candidate) => candidate.key === parsed.key);
    if (!entry) {
      throw new ServiceError("not_found", `No app "${key}" in the catalogue`);
    }

    // There is no unique workspace/catalog_key index: concurrent double-adds
    // can pass this check together and create two rows.
    const now = clock.now();
    const connectorId = ulid(now.getTime());
    await db.insert(connectors).values({
      authKind: entry.authKind,
      // Force the vendor's mode without probing; OAuth discovery is lazy at connect.
      authMode: entry.authKind,
      callTimeoutSeconds: CONNECTOR_CALL_TIMEOUT_SECONDS.default,
      catalogKey: entry.key,
      createdAt: now.toISOString(),
      createdBy: user.userId,
      headerName: entry.authKind === "header" ? "Authorization" : null,
      headerTemplate: null,
      id: connectorId,
      name: entry.name,
      oauth: null,
      secretId: null,
      status: entry.authKind === "none" ? "ok" : "needs_auth",
      tools: "[]",
      toolsFetchedAt: null,
      url: canonicalizeConnectorUrl(entry.url),
      workspaceId,
    });
    return { connectorId };
  };

  return { add, list };
};

export type CatalogService = ReturnType<typeof createCatalogService>;
