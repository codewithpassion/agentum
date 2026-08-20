import { Link } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { Button } from "#/components/ui/button";
import type { WikiPageSummary } from "#/lib/api";
import { cx } from "#/lib/cx";
import { buildWikiTree, type WikiTreeNode, wikiNodeLabel } from "./wiki-tree";

/** Each level steps in by this much, so depth reads at a glance. */
const INDENT_PX = 12;

/**
 * One row of the tree. A node with children carries its own chevron; every node
 * is a link, because a folder that has no page of its own opens the index of
 * what is inside it.
 */
function TreeRow({
  activeSlug,
  depth,
  node,
}: {
  activeSlug: string | null;
  depth: number;
  node: WikiTreeNode;
}) {
  const [expanded, setExpanded] = useState(true);
  const toggle = useCallback(() => setExpanded((open) => !open), []);
  const label = wikiNodeLabel(node);
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <div
        className="flex items-center gap-0.5"
        style={{ paddingLeft: depth * INDENT_PX }}
      >
        {hasChildren ? (
          <button
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
            className="ws-focus rounded px-1 text-[10px] text-[var(--ws-muted)] hover:text-[var(--ws-text)]"
            onClick={toggle}
            type="button"
          >
            <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
          </button>
        ) : (
          <span aria-hidden="true" className="w-4 shrink-0" />
        )}
        <Link
          className={cx(
            "ws-focus block min-w-0 flex-1 truncate rounded-lg px-2 py-1.5 text-[13px] no-underline",
            node.path === activeSlug
              ? "bg-[var(--ws-surface-hover)] text-[var(--ws-text)]"
              : "text-[var(--ws-muted)] hover:bg-[var(--ws-surface)] hover:text-[var(--ws-text)]"
          )}
          params={{ _splat: node.path }}
          to="/wiki/$"
        >
          {label}
        </Link>
      </div>

      {expanded
        ? node.children.map((child) => (
            <TreeRow
              activeSlug={activeSlug}
              depth={depth + 1}
              key={child.path}
              node={child}
            />
          ))
        : null}
    </div>
  );
}

/**
 * The wiki's tree, built from the page slugs: `ops/runbooks/deploy` nests itself
 * under folders that exist only as long as something is inside them.
 */
export function PageTree({
  activeSlug,
  onNewPage,
  pages,
}: {
  activeSlug: string | null;
  onNewPage: () => void;
  pages: WikiPageSummary[];
}) {
  const tree = useMemo(() => buildWikiTree(pages), [pages]);

  return (
    <nav
      aria-label="Wiki pages"
      className="flex w-70 shrink-0 flex-col border-[var(--ws-line)] border-r bg-[var(--ws-panel)]"
    >
      <div className="flex items-center justify-between gap-2 px-3 py-3">
        <Link
          className="ws-focus rounded-lg px-1 py-0.5 text-[13px] text-[var(--ws-muted)] no-underline hover:text-[var(--ws-text)]"
          to="/"
        >
          ‹ Workspace
        </Link>
        <Button onClick={onNewPage} size="sm" variant="subtle">
          New page
        </Button>
      </div>

      <p className="m-0 px-4 pt-2 pb-1 font-medium text-[10px] text-[var(--ws-muted)] uppercase tracking-wide">
        Wiki
      </p>

      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {tree.length === 0 ? (
          <p className="m-0 px-2 py-1 text-[var(--ws-muted)] text-xs">
            No pages yet.
          </p>
        ) : null}
        {tree.map((node) => (
          <TreeRow
            activeSlug={activeSlug}
            depth={0}
            key={node.path}
            node={node}
          />
        ))}
      </div>
    </nav>
  );
}
