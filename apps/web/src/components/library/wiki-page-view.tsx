import { replaceWikiLinks } from "@repo/services/wiki/links";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Markdown,
  type MarkdownLinkProps,
} from "#/components/markdown/markdown.tsx";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import type {
  LibraryVersionRecord,
  WikiPageRecord,
} from "#/integrations/trpc/types";
import { LibraryFilePanel } from "./library-file-panel.tsx";
import { LibraryHistory } from "./library-history-panel.tsx";
import { errorMessage, formatMtime } from "./library-logic.ts";
import { WikiBrokenChip, WikiLiveChip } from "./wiki-link-chip.tsx";
import { wikiLinkChip } from "./wiki-logic.ts";

interface WikiPageViewProps {
  /** A change to the library, so the parent can refresh its tree. */
  onChanged: () => void;
  onClosed: () => void;
  /** A click on a link to a missing page, with the title the link names. */
  onCreateMissing: (title: string) => void;
  path: string;
  /** Goes up when the page refetches. The view then rereads the page. */
  refreshTick: number;
}

const author = (version: LibraryVersionRecord): string =>
  version.authorKind === "agent"
    ? `Agent ${version.authorId}`
    : version.authorId;

/** One wiki page: rendered markdown with live and broken link chips, backlinks, its version, and its history. */
export function WikiPageView({
  onChanged,
  onClosed,
  onCreateMissing,
  path,
  refreshTick,
}: WikiPageViewProps) {
  const [page, setPage] = useState<WikiPageRecord | null>(null);
  const [latest, setLatest] = useState<LibraryVersionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  // Bumped when an edit ends or a version is restored, so the page and its history reread.
  const [generation, setGeneration] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: generation and refreshTick only trigger a reread
  useEffect(() => {
    let current = true;
    const load = async () => {
      try {
        const [nextPage, versions] = await Promise.all([
          getTrpc().wiki.page.query({ path }),
          getTrpc().library.versions.query({ path }),
        ]);
        if (current) {
          setPage(nextPage);
          setLatest(versions[0] ?? null);
          setError(null);
        }
      } catch (cause) {
        if (current) {
          setError(errorMessage(cause));
        }
      }
    };
    load();
    return () => {
      current = false;
    };
  }, [path, generation, refreshTick]);

  const startEditing = useCallback(() => setEditing(true), []);
  const stopEditing = useCallback(() => {
    setEditing(false);
    setGeneration((count) => count + 1);
  }, []);
  const restored = useCallback(() => {
    setGeneration((count) => count + 1);
    onChanged();
  }, [onChanged]);

  const links = page?.links;
  const renderLink = useMemo(
    () =>
      function renderWikiLink({ children, href }: MarkdownLinkProps) {
        const chip = wikiLinkChip(href, links ?? []);
        if (chip.kind === "external") {
          return (
            <a
              className="underline underline-offset-2"
              href={href}
              rel="noopener noreferrer"
              target="_blank"
            >
              {children}
            </a>
          );
        }
        return chip.broken ? (
          <WikiBrokenChip onCreate={onCreateMissing} title={chip.title}>
            {children}
          </WikiBrokenChip>
        ) : (
          <WikiLiveChip path={chip.path}>{children}</WikiLiveChip>
        );
      },
    [links, onCreateMissing]
  );

  if (editing) {
    return (
      <LibraryFilePanel
        key={path}
        onChanged={onChanged}
        onClosed={stopEditing}
        path={path}
        refreshTick={refreshTick}
      />
    );
  }

  return (
    <article
      className="flex flex-col gap-4 rounded-lg border p-4"
      data-testid="wiki-page"
    >
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      {page === null ? (
        error === null && (
          <p className="text-muted-foreground text-sm">Loading...</p>
        )
      ) : (
        <>
          <header className="flex flex-wrap items-center gap-2">
            <h2 className="min-w-0 flex-1 truncate font-heading text-xl">
              {page.title}
            </h2>
            {latest === null ? null : (
              <>
                <Badge data-testid="wiki-version" variant="secondary">
                  v{latest.version}
                </Badge>
                <span
                  className="text-muted-foreground text-sm"
                  data-testid="wiki-author"
                >
                  Edited by {author(latest)}, {formatMtime(latest.createdAt)}
                </span>
              </>
            )}
            <Button
              data-testid="wiki-edit"
              onClick={startEditing}
              size="sm"
              type="button"
              variant="outline"
            >
              Edit
            </Button>
          </header>
          <div data-testid="wiki-body">
            <Markdown renderLink={renderLink}>
              {replaceWikiLinks(page.body)}
            </Markdown>
          </div>
          <Backlinks backlinks={page.backlinks} />
          <LibraryHistory
            onRestored={restored}
            path={path}
            refreshKey={generation + refreshTick}
          />
        </>
      )}
      <div className="flex justify-end">
        <Button onClick={onClosed} type="button" variant="ghost">
          Close
        </Button>
      </div>
    </article>
  );
}

function Backlinks({ backlinks }: { backlinks: WikiPageRecord["backlinks"] }) {
  return (
    <section
      aria-label="Linked from"
      className="flex flex-wrap items-center gap-2 text-sm"
      data-testid="wiki-backlinks"
    >
      <span className="text-muted-foreground">Linked from</span>
      {backlinks.length === 0 ? (
        <span className="text-muted-foreground">no page yet</span>
      ) : (
        backlinks.map((backlink) => (
          <WikiLiveChip key={backlink.path} path={backlink.path}>
            {backlink.title}
          </WikiLiveChip>
        ))
      )}
    </section>
  );
}
