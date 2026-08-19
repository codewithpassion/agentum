import { Link } from "@tanstack/react-router";
import { Button } from "#/components/ui/button";
import type { WikiPageSummary } from "#/lib/api";
import { cx } from "#/lib/cx";

/**
 * The wiki is flat for now, so the "tree" is one level: every page, by title.
 * Nesting can come from title prefixes later without changing the route shape.
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
        {pages.length === 0 ? (
          <p className="m-0 px-2 py-1 text-[var(--ws-muted)] text-xs">
            No pages yet.
          </p>
        ) : null}
        {pages.map((page) => (
          <Link
            className={cx(
              "ws-focus block truncate rounded-lg px-2 py-1.5 text-[13px] no-underline",
              page.slug === activeSlug
                ? "bg-[var(--ws-surface-hover)] text-[var(--ws-text)]"
                : "text-[var(--ws-muted)] hover:bg-[var(--ws-surface)] hover:text-[var(--ws-text)]"
            )}
            key={page.id}
            params={{ slug: page.slug }}
            to="/wiki/$slug"
          >
            {page.title}
          </Link>
        ))}
      </div>
    </nav>
  );
}
