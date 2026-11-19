import type { CatalogEntry } from "@repo/db/shared";
import { z } from "zod";
import { authorize } from "./authz.ts";
import { ServiceError } from "./errors.ts";
import { readableWorkspace } from "./guards.ts";
import type { Principal } from "./workspaces.ts";

const CATALOG_ADD = "catalog.add";
const CATALOG_KIND = "catalog";

export const catalogAddInputSchema = z.strictObject({
  key: z.string().min(1),
});

/**
 * Stub: the catalogue is empty, so every key is unknown. The catalogue service
 * task fills the entries and creates the connector row on `add`.
 */
export const createCatalogService = () => {
  const list = (): CatalogEntry[] => [];

  const add = (
    principal: Principal,
    key: string
  ): Promise<{ connectorId: string }> => {
    const workspaceId = readableWorkspace(principal, CATALOG_ADD);
    authorize(principal, CATALOG_ADD, { kind: CATALOG_KIND, workspaceId });
    return Promise.reject(
      new ServiceError("not_found", `No app "${key}" in the catalogue`)
    );
  };

  return { add, list };
};

export type CatalogService = ReturnType<typeof createCatalogService>;
