import type { ReactNode } from "react";
import { Button } from "#/components/ui/button";
import {
  Markdown,
  type MarkdownLinkProps,
} from "#/components/workspace/markdown";
import type { WikiPage, WikiRevision } from "#/lib/api";
import { formatDay, formatTime } from "#/lib/format";
import { replaceWikiLinks } from "#/modules/wiki/wiki-links";

/**
 * The read view of a page, or of one of its past revisions - the same rendering
 * either way, so what a revision looked like is what you see.
 */
export function PageView({
  historyOpen,
  onDelete,
  onEdit,
  onRestore,
  onStopViewingRevision,
  onToggleHistory,
  page,
  renderLink,
  revision,
}: {
  historyOpen: boolean;
  onDelete: () => void;
  onEdit: () => void;
  onRestore: () => void;
  onStopViewingRevision: () => void;
  onToggleHistory: () => void;
  page: WikiPage;
  renderLink: (props: MarkdownLinkProps) => ReactNode;
  /** When set, the page body is replaced by this past revision. */
  revision: WikiRevision | null;
}): ReactNode {
  const title = revision ? revision.title : page.title;
  const body = revision ? revision.body : page.body;
  const at = revision ? revision.createdAt : page.updatedAt;

  return (
    <article className="flex min-h-0 flex-1 flex-col" data-testid="wiki-page">
      <header className="flex items-start justify-between gap-3 border-[var(--ws-line)] border-b px-6 py-4">
        <div className="min-w-0">
          <h1 className="m-0 truncate font-semibold text-xl">{title}</h1>
          <p className="m-0 text-[var(--ws-muted)] text-xs">
            {revision ? "Revision from" : "Updated"} {formatDay(at)}{" "}
            {formatTime(at)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {revision ? (
            <>
              <Button onClick={onStopViewingRevision} size="sm">
                Back to current
              </Button>
              <Button onClick={onRestore} size="sm" variant="primary">
                Restore
              </Button>
            </>
          ) : (
            <>
              <Button onClick={onEdit} size="sm" variant="primary">
                Edit
              </Button>
              <Button onClick={onToggleHistory} size="sm">
                {historyOpen ? "Hide history" : "History"}
              </Button>
              <Button onClick={onDelete} size="sm" variant="danger">
                Delete
              </Button>
            </>
          )}
        </div>
      </header>

      <div
        className="min-h-0 flex-1 overflow-y-auto px-6 py-4"
        data-testid="wiki-body"
      >
        {body.trim().length === 0 ? (
          <p className="m-0 text-[var(--ws-muted)] text-sm">
            This page is empty. Click Edit to write it.
          </p>
        ) : (
          <Markdown
            anchors
            body={replaceWikiLinks(body)}
            renderLink={renderLink}
          />
        )}
      </div>
    </article>
  );
}
