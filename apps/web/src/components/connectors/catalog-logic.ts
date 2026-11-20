import type { CatalogEntry } from "@repo/db/shared";
import type { ConnectorRecord } from "#/integrations/trpc/types";

const sameName = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The catalogue entries the workspace has no connector for yet. An entry counts
 * as present when a connector came from it or carries its name. Empty when the
 * catalogue could not be read (null).
 */
export const catalogEntriesToAdd = (
  catalog: CatalogEntry[] | null,
  connectors: ConnectorRecord[]
): CatalogEntry[] =>
  (catalog ?? []).filter(
    (entry) =>
      !connectors.some(
        (connector) =>
          connector.catalogKey === entry.key ||
          sameName(connector.name, entry.name)
      )
  );
