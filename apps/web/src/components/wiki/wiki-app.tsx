import { useUser } from "@clerk/tanstack-react-start";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Button } from "#/components/ui/button";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import type { WikiRevision } from "#/lib/api";
import { useWikiPage, useWikiPages } from "#/lib/use-wiki";
import { useApi, useWorkspaceSlug } from "#/lib/workspace-context";
import { NewPageDialog } from "./new-page-dialog";
import { PageEditor } from "./page-editor";
import { PageTree } from "./page-tree";
import { PageView } from "./page-view";
import { RevisionsPanel } from "./revisions-panel";
import { createWikiLinkRenderer } from "./wiki-link";
import {
  type WikiTreeNode,
  wikiFolderChildren,
  wikiNodeLabel,
} from "./wiki-tree";

function SignedOutNotice() {
  return (
    <div className="ws-shell items-center justify-center">
      <div className="max-w-sm space-y-3 px-6 text-center">
        <h1 className="m-0 font-semibold text-xl">Wiki</h1>
        <p className="m-0 text-[var(--ws-muted)] text-sm">
          Sign in to read and edit the workspace wiki.
        </p>
        <a
          className="ws-accent-button inline-block rounded-lg bg-[var(--ws-accent)] px-4 py-2 font-medium text-sm no-underline"
          href="/login"
        >
          Sign in
        </a>
      </div>
    </div>
  );
}

function NoPageSelected({ onNewPage }: { onNewPage: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="space-y-3 text-center">
        <p className="m-0 text-[var(--ws-muted)] text-sm">
          Pick a page on the left, or start a new one.
        </p>
        <Button onClick={onNewPage} variant="primary">
          New page
        </Button>
      </div>
    </div>
  );
}

function MissingPage({
  onCreate,
  title,
}: {
  onCreate: () => void;
  title: string;
}) {
  return (
    <div
      className="flex flex-1 items-center justify-center"
      data-testid="wiki-missing"
    >
      <div className="space-y-3 text-center">
        <p className="m-0 text-sm">
          <strong>{title}</strong> has not been written yet.
        </p>
        <Button onClick={onCreate} variant="primary">
          Create this page
        </Button>
      </div>
    </div>
  );
}

/**
 * A path that has pages under it but none of its own: rather than offering to
 * write it, the wiki shows what is inside - while still letting the folder get a
 * page of its own.
 */
function FolderIndex({
  entries,
  onCreate,
  path,
}: {
  entries: WikiTreeNode[];
  onCreate: () => void;
  path: string;
}) {
  const workspaceSlug = useWorkspaceSlug();

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="wiki-folder">
      <header className="flex items-start justify-between gap-3 border-[var(--ws-line)] border-b px-6 py-4">
        <div className="min-w-0">
          <h1 className="m-0 truncate font-semibold text-xl">
            {path.split("/").at(-1)}
          </h1>
          <p className="m-0 text-[var(--ws-muted)] text-xs">
            {entries.length} inside · no page of its own yet
          </p>
        </div>
        <Button onClick={onCreate} size="sm" variant="primary">
          Create this page
        </Button>
      </header>

      <ul className="m-0 min-h-0 flex-1 list-none overflow-y-auto px-6 py-4">
        {entries.map((child) => (
          <li className="py-1" key={child.path}>
            <Link
              params={{ _splat: child.path, workspaceSlug }}
              to="/w/$workspaceSlug/wiki/$"
            >
              {wikiNodeLabel(child)}
              {child.page ? "" : "/"}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The whole wiki surface: page tree, read view, editor and revision history.
 * Which page is open lives in the route, and everything that changes it is a
 * click - there is no URL to type.
 */
export function WikiApp({
  draftTitle,
  edit,
  prefillTitle,
  slug,
}: {
  /** Set while a new page is being written; it exists only once saved. */
  draftTitle?: string;
  edit: boolean;
  /** Carried by a link to a page that does not exist yet. */
  prefillTitle?: string;
  slug: string | null;
}) {
  const api = useApi();
  const workspaceSlug = useWorkspaceSlug();

  const { isSignedIn } = useUser();
  const signedIn = isSignedIn === true;
  const navigate = useNavigate();

  const {
    error: pagesError,
    pages,
    reload: reloadPages,
  } = useWikiPages(signedIn);
  const {
    error: pageError,
    missing,
    page,
    setPage,
  } = useWikiPage(slug, signedIn);

  const [agentNames, setAgentNames] = useState<ReadonlyMap<string, string>>(
    new Map()
  );
  const [revisions, setRevisions] = useState<WikiRevision[]>([]);
  const [viewingRevision, setViewingRevision] = useState<WikiRevision | null>(
    null
  );
  /** History belongs to one page: it is open only while that page is open. */
  const [historySlug, setHistorySlug] = useState<string | null>(null);
  const [newPageOpen, setNewPageOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const historyOpen = slug !== null && historySlug === slug;
  const revision =
    viewingRevision && page && viewingRevision.pageId === page.id
      ? viewingRevision
      : null;

  const knownSlugs = useMemo(
    () => new Set(pages.map((entry) => entry.slug)),
    [pages]
  );
  const renderLink = useMemo(
    () => createWikiLinkRenderer(knownSlugs),
    [knownSlugs]
  );
  /** Non-empty when the open address is a folder: pages live under it. */
  const folderChildren = useMemo(
    () => (slug ? wikiFolderChildren(pages, slug) : []),
    [pages, slug]
  );

  // Agents author revisions through the MCP tools; their names come from the
  // agents API rather than from the wiki module.
  useEffect(() => {
    if (!signedIn) {
      return;
    }
    api
      .listAgents()
      .then((agents) =>
        setAgentNames(new Map(agents.map((agent) => [agent.id, agent.name])))
      )
      .catch(() => setAgentNames(new Map()));
  }, [api, signedIn]);

  const refreshRevisions = useCallback(async () => {
    if (!slug) {
      return;
    }
    setRevisions(await api.listWikiRevisions(slug));
  }, [api, slug]);

  useEffect(() => {
    if (historyOpen) {
      refreshRevisions();
    }
  }, [historyOpen, refreshRevisions]);

  const openPage = useCallback(
    (nextSlug: string, editing: boolean) =>
      navigate({
        params: { _splat: nextSlug, workspaceSlug },
        search: editing ? { edit: true } : {},
        to: "/w/$workspaceSlug/wiki/$",
      }),
    [navigate, workspaceSlug]
  );

  const openNewPage = useCallback(() => setNewPageOpen(true), []);
  const closeNewPage = useCallback(() => setNewPageOpen(false), []);
  const toggleHistory = useCallback(
    () => setHistorySlug((current) => (current === slug ? null : slug)),
    [slug]
  );
  const closeHistory = useCallback(() => setHistorySlug(null), []);
  const stopViewingRevision = useCallback(() => setViewingRevision(null), []);
  const askDelete = useCallback(() => setDeleteOpen(true), []);
  const cancelDelete = useCallback(() => setDeleteOpen(false), []);

  const startEdit = useCallback(() => {
    if (slug) {
      openPage(slug, true);
    }
  }, [openPage, slug]);

  const stopEdit = useCallback(() => {
    if (slug) {
      openPage(slug, false);
    }
  }, [openPage, slug]);

  /** A draft lives in the route, so navigating away simply drops it. */
  const startDraft = useCallback(
    (title: string) => {
      setNewPageOpen(false);
      navigate({
        params: { workspaceSlug },
        search: { new: title },
        to: "/w/$workspaceSlug/wiki",
      });
    },
    [navigate, workspaceSlug]
  );

  const cancelDraft = useCallback(() => {
    navigate({
      params: { workspaceSlug },
      search: {},
      to: "/w/$workspaceSlug/wiki",
    });
  }, [navigate, workspaceSlug]);

  const createPage = useCallback(
    async (input: { body: string; title: string }) => {
      const created = await api.createWikiPage(input);
      await reloadPages();
      await openPage(created.slug, false);
    },
    [api, openPage, reloadPages]
  );

  const startMissingPageDraft = useCallback(() => {
    startDraft(prefillTitle?.trim() || (slug ?? ""));
  }, [prefillTitle, slug, startDraft]);

  const savePage = useCallback(
    async (input: { body: string; title: string }) => {
      if (!slug) {
        return;
      }
      setPage(await api.updateWikiPage(slug, input));
      await reloadPages();
      if (historyOpen) {
        await refreshRevisions();
      }
      await openPage(slug, false);
    },
    [api, historyOpen, openPage, refreshRevisions, reloadPages, setPage, slug]
  );

  const restoreRevision = useCallback(async () => {
    if (!(slug && viewingRevision)) {
      return;
    }
    setPage(
      await api.updateWikiPage(slug, {
        body: viewingRevision.body,
        title: viewingRevision.title,
      })
    );
    setViewingRevision(null);
    await reloadPages();
    await refreshRevisions();
  }, [api, refreshRevisions, reloadPages, setPage, slug, viewingRevision]);

  const confirmDelete = useCallback(async () => {
    if (!slug) {
      return;
    }
    await api.deleteWikiPage(slug);
    setDeleteOpen(false);
    await reloadPages();
    await navigate({
      params: { workspaceSlug },
      search: {},
      to: "/w/$workspaceSlug/wiki",
    });
  }, [api, navigate, reloadPages, slug, workspaceSlug]);

  if (isSignedIn === false) {
    return <SignedOutNotice />;
  }

  const error = pagesError ?? pageError;

  let content: ReactNode = null;
  if (draftTitle !== undefined) {
    content = (
      <div className="flex min-h-0 flex-1 flex-col p-6">
        <PageEditor
          initialBody=""
          initialTitle={draftTitle}
          onCancel={cancelDraft}
          onSave={createPage}
          renderLink={renderLink}
        />
      </div>
    );
  } else if (!slug) {
    content = <NoPageSelected onNewPage={openNewPage} />;
  } else if (missing && folderChildren.length > 0) {
    content = (
      <FolderIndex
        entries={folderChildren}
        onCreate={startMissingPageDraft}
        path={slug}
      />
    );
  } else if (missing) {
    content = (
      <MissingPage
        onCreate={startMissingPageDraft}
        title={prefillTitle?.trim() || slug}
      />
    );
  } else if (page && edit) {
    content = (
      <div className="flex min-h-0 flex-1 flex-col p-6">
        <PageEditor
          initialBody={page.body}
          initialTitle={page.title}
          onCancel={stopEdit}
          onSave={savePage}
          pageId={page.id}
          renderLink={renderLink}
        />
      </div>
    );
  } else if (page) {
    content = (
      <PageView
        historyOpen={historyOpen}
        onDelete={askDelete}
        onEdit={startEdit}
        onRestore={restoreRevision}
        onStopViewingRevision={stopViewingRevision}
        onToggleHistory={toggleHistory}
        page={page}
        renderLink={renderLink}
        revision={revision}
      />
    );
  }

  return (
    <div className="ws-shell">
      <PageTree activeSlug={slug} onNewPage={openNewPage} pages={pages} />

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">{content}</main>

      {historyOpen && page ? (
        <RevisionsPanel
          agentNames={agentNames}
          onClose={closeHistory}
          onView={setViewingRevision}
          revisions={revisions}
          viewingId={revision ? revision.id : null}
        />
      ) : null}

      {error ? (
        <p className="fixed bottom-3 left-3 m-0 rounded-lg bg-[var(--ws-surface)] px-3 py-2 text-[var(--ws-danger)] text-xs">
          {error}
        </p>
      ) : null}

      <NewPageDialog
        onClose={closeNewPage}
        onStart={startDraft}
        open={newPageOpen}
      />

      <ConfirmDialog
        confirmLabel="Delete page"
        message={`Delete ${page ? page.title : "this page"}? Its revisions go with it.`}
        onCancel={cancelDelete}
        onConfirm={confirmDelete}
        open={deleteOpen}
        title="Delete page"
      />
    </div>
  );
}
