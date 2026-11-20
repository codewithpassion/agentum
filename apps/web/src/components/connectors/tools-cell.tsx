import type { CatalogEntry } from "@repo/db/shared";
import type { ConnectorRecord } from "#/integrations/trpc/types";

export interface ToolsCellWords {
  count: string;
  names: string;
  note: string | null;
}

interface ToolsCellInput {
  catalog: CatalogEntry[] | null;
  connector: Pick<ConnectorRecord, "catalogKey" | "tools" | "toolsFetchedAt">;
}

const NOT_FETCHED = "Not fetched yet";
const NOT_FETCHED_NOTE = "Tool list not fetched yet";

/**
 * What the Tools column shows. A connector with a cached tool list, or one
 * added by hand, shows that list. A catalogue connector that has not
 * connected yet shows how many tools the catalogue allows by default.
 */
export function toolsCellWords({
  catalog,
  connector,
}: ToolsCellInput): ToolsCellWords {
  if (connector.catalogKey === null || connector.toolsFetchedAt !== null) {
    const names = connector.tools.map((tool) => tool.name);
    return {
      count: String(connector.tools.length),
      names: names.join(", "),
      note: null,
    };
  }
  const entry = catalog?.find((item) => item.key === connector.catalogKey);
  const defaults = entry?.defaultAllowedTools ?? [];
  if (defaults.length === 0) {
    return { count: NOT_FETCHED, names: "", note: null };
  }
  return {
    count: `${defaults.length} by default`,
    names: defaults.join(", "),
    note: NOT_FETCHED_NOTE,
  };
}

export function ToolsCell({ catalog, connector }: ToolsCellInput) {
  const words = toolsCellWords({ catalog, connector });
  return (
    <div className="flex flex-col gap-1">
      <span>{words.count}</span>
      {words.note === null ? null : (
        <span className="text-muted-foreground text-xs">{words.note}</span>
      )}
      {words.names.length > 0 && (
        <span
          className="max-w-64 truncate text-muted-foreground text-xs"
          title={words.names}
        >
          {words.names}
        </span>
      )}
    </div>
  );
}
