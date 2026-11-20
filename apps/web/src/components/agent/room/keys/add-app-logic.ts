import type { CatalogEntry } from "@repo/db/shared";
import type { ConnectorRecord } from "#/integrations/trpc/types";

/** One thing the "Add an app" menu can add: an app from the catalogue or a connector the workspace already has. */
export type AddChoice =
  | { disabled: boolean; entry: CatalogEntry; kind: "catalog"; label: string }
  | {
      connector: ConnectorRecord;
      disabled: boolean;
      kind: "connector";
      label: string;
    };

const sameName = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/** The select value of a choice. Catalogue keys and connector ids never clash, the prefix says which is which. */
export const choiceValue = (choice: AddChoice): string =>
  choice.kind === "catalog"
    ? `catalog:${choice.entry.key}`
    : `connector:${choice.connector.id}`;

const isSecretBacked = (connector: ConnectorRecord): boolean =>
  Boolean(connector.secretId || connector.headerTemplate);

/**
 * What the menu offers. Connectors the agent already has are left out. A
 * catalogue entry the workspace already has as a connector is left out too,
 * because the connector itself is listed. Only an admin adds from the
 * catalogue, and a member may not add an app that runs on a workspace secret.
 */
export const addChoices = ({
  assignedIds,
  catalog,
  connectors,
  isAdmin,
}: {
  assignedIds: ReadonlySet<string>;
  catalog: CatalogEntry[];
  connectors: ConnectorRecord[];
  isAdmin: boolean;
}): AddChoice[] => {
  const free = connectors.filter((connector) => !assignedIds.has(connector.id));
  const fromCatalog: AddChoice[] = catalog
    .filter(
      (entry) =>
        !connectors.some((connector) => sameName(connector.name, entry.name))
    )
    .map((entry) => ({
      disabled: !isAdmin,
      entry,
      kind: "catalog",
      label: isAdmin ? entry.name : `${entry.name} (admin only)`,
    }));
  const fromWorkspace: AddChoice[] = free.map((connector) => {
    const blocked = isSecretBacked(connector) && !isAdmin;
    return {
      connector,
      disabled: blocked,
      kind: "connector",
      label: blocked ? `${connector.name} (admin only)` : connector.name,
    };
  });
  return [...fromCatalog, ...fromWorkspace];
};

/** The tools a new agent may call from a catalogue entry, or undefined for every tool when the entry lists none. */
export const catalogAllowedTools = (
  entry: CatalogEntry
): string[] | undefined =>
  entry.defaultAllowedTools.length > 0 ? entry.defaultAllowedTools : undefined;
