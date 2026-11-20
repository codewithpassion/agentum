import type { CatalogEntry } from "@repo/db/shared";
import type { ConnectorRecord } from "#/integrations/trpc/types";

/** One thing the "Add an app" menu can add: an app from the catalogue or a connector the workspace already has. */
export type AddChoice =
  | { disabled: boolean; entry: CatalogEntry; kind: "catalog"; label: string }
  | {
      /** The catalogue entry's default tools when the connector came from the catalogue, else undefined (every tool). */
      allowedTools: string[] | undefined;
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

/** The tools a new agent may call from a catalogue entry, or undefined for every tool when the entry lists none. */
export const catalogAllowedTools = (
  entry: CatalogEntry
): string[] | undefined =>
  entry.defaultAllowedTools.length > 0 ? entry.defaultAllowedTools : undefined;

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
        !connectors.some(
          (connector) =>
            connector.catalogKey === entry.key ||
            sameName(connector.name, entry.name)
        )
    )
    .map((entry) => ({
      disabled: !isAdmin,
      entry,
      kind: "catalog",
      label: isAdmin ? entry.name : `${entry.name} (admin only)`,
    }));
  const fromWorkspace: AddChoice[] = free.map((connector) => {
    const blocked = isSecretBacked(connector) && !isAdmin;
    const source = catalog.find((item) => item.key === connector.catalogKey);
    return {
      allowedTools:
        source === undefined ? undefined : catalogAllowedTools(source),
      connector,
      disabled: blocked,
      kind: "connector",
      label: blocked ? `${connector.name} (admin only)` : connector.name,
    };
  });
  return [...fromCatalog, ...fromWorkspace];
};
