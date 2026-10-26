import { Link } from "@tanstack/react-router";
import { useCallback } from "react";
import { Button } from "#/components/ui/button.tsx";
import type { WikiPageNodeRecord } from "#/integrations/trpc/types";
import {
  flattenWikiTree,
  type WikiTreeRow as WikiTreeRowData,
} from "./wiki-logic.ts";

export interface WikiTreeProps {
  activePath: string | undefined;
  nodes: readonly WikiPageNodeRecord[];
  onNewPage: () => void;
}

interface WikiTreeRowProps {
  activePath: string | undefined;
  row: WikiTreeRowData;
}

function WikiTreeRow({ activePath, row }: WikiTreeRowProps) {
  const { node } = row;
  const search = useCallback(
    (previous: { dir?: string; file?: string; wiki?: string }) => ({
      ...previous,
      wiki: node.path,
    }),
    [node.path]
  );
  const style = { paddingLeft: row.depth * 12 };
  if (!row.isPage) {
    return (
      <li data-testid="wiki-tree-row" style={style}>
        <span className="block truncate px-2 py-1 text-muted-foreground text-sm">
          {node.title}
        </span>
      </li>
    );
  }
  const isActive = node.path === activePath;
  return (
    <li data-testid="wiki-tree-row" style={style}>
      <Link
        aria-current={isActive ? "page" : undefined}
        className={
          isActive
            ? "block truncate rounded bg-muted px-2 py-1 font-medium text-sm hover:bg-muted"
            : "block truncate rounded px-2 py-1 text-sm hover:bg-muted"
        }
        search={search}
        to="/library"
      >
        {node.title}
      </Link>
    </li>
  );
}

export function WikiTree({ activePath, nodes, onNewPage }: WikiTreeProps) {
  const rows = flattenWikiTree(nodes);
  return (
    <nav
      aria-label="Wiki pages"
      className="flex flex-col gap-2 rounded-lg border p-3"
      data-testid="wiki-tree"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-muted-foreground text-xs uppercase tracking-wide">
          Wiki
        </span>
        <Button
          data-testid="wiki-new-page"
          onClick={onNewPage}
          size="sm"
          type="button"
          variant="outline"
        >
          New page
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">No pages yet.</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {rows.map((row) => (
            <WikiTreeRow
              activePath={activePath}
              key={row.node.path}
              row={row}
            />
          ))}
        </ul>
      )}
    </nav>
  );
}
