import type { CatalogEntry } from "@repo/db/shared";
import { useCallback, useMemo } from "react";
import { getTrpc } from "#/integrations/trpc/client";
import type { ConnectorRecord } from "#/integrations/trpc/types";
import { AppPicker } from "./app-picker.tsx";
import { catalogEntriesToAdd } from "./catalog-logic.ts";

/**
 * Adds an app from the catalogue to the workspace as a connector. For admins:
 * the server refuses anyone else. Renders nothing when there is nothing to add.
 */
export function AddFromCatalogue({
  catalog,
  connectors,
  onAdded,
}: {
  /** Null when the catalogue could not be read. */
  catalog: CatalogEntry[] | null;
  connectors: ConnectorRecord[];
  /** Called after the connector is made, with the entry it came from. */
  onAdded: (entry: CatalogEntry) => void | Promise<void>;
}) {
  const entries = useMemo(
    () => catalogEntriesToAdd(catalog, connectors),
    [catalog, connectors]
  );
  const groups = useMemo(
    () => [
      {
        label: "From the catalogue",
        options: entries.map((entry) => ({
          disabled: false,
          label: entry.name,
          value: entry.key,
        })),
      },
    ],
    [entries]
  );

  const add = useCallback(
    async (key: string) => {
      const entry = entries.find((item) => item.key === key);
      if (entry === undefined) {
        return;
      }
      await getTrpc().catalog.add.mutate({ key: entry.key });
      await onAdded(entry);
    },
    [entries, onAdded]
  );

  if (entries.length === 0) {
    return null;
  }
  return (
    <div className="mb-6 flex flex-col gap-2">
      <p className="font-medium text-sm">Add from the catalogue</p>
      <AppPicker disabled={false} groups={groups} onAdd={add} />
    </div>
  );
}
