import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { useCallback, useState } from "react";
import { z } from "zod";
import { LibraryFilePanel } from "#/components/library/library-file-panel";
import { LibraryList } from "#/components/library/library-list";
import { errorMessage, remapPath } from "#/components/library/library-logic";
import { LibraryToolbar } from "#/components/library/library-toolbar";
import { useLibraryRefresh } from "#/components/library/use-library-refresh";
import { WikiNewPageDialog } from "#/components/library/wiki-new-page-dialog";
import { WikiPageView } from "#/components/library/wiki-page-view";
import { WikiTree } from "#/components/library/wiki-tree";
import { getTrpc } from "#/integrations/trpc/client";
import type { LibraryEntryRecord } from "#/integrations/trpc/types";

const searchSchema = z.object({
  dir: z.string().min(1).optional().catch(undefined),
  file: z.string().min(1).optional().catch(undefined),
  wiki: z.string().min(1).optional().catch(undefined),
});

export const Route = createFileRoute("/_app/library")({
  validateSearch: (search) => searchSchema.parse(search),
  loaderDeps: ({ search }) => ({ dir: search.dir ?? "" }),
  loader: async ({ deps }) => {
    try {
      const [entries, pages] = await Promise.all([
        getTrpc().library.list.query({ dir: deps.dir }),
        getTrpc().wiki.pages.query(),
      ]);
      return { entries, pages };
    } catch (error) {
      if (
        error instanceof TRPCClientError &&
        error.data?.code === "UNAUTHORIZED"
      ) {
        throw redirect({ to: "/login" });
      }
      throw error;
    }
  },
  component: LibraryPage,
});

function LibraryPage() {
  const loaded = Route.useLoaderData();
  const { dir = "", file, wiki } = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => router.invalidate(), [router]);
  // The 5 s refresh reads the listing on its own instead of invalidating the router, so a failed
  // read keeps the page as it is. A newer loader result replaces what it fetched.
  const [polled, setPolled] = useState<{
    from: typeof loaded;
    latest: typeof loaded;
  } | null>(null);
  const shown =
    polled !== null && polled.from === loaded ? polled.latest : loaded;
  const pollListing = useCallback(async () => {
    try {
      const [entries, pages] = await Promise.all([
        getTrpc().library.list.query({ dir }),
        getTrpc().wiki.pages.query(),
      ]);
      setPolled({ from: loaded, latest: { entries, pages } });
    } catch {
      // Keep the listing on screen. The next tick tries again.
    }
  }, [dir, loaded]);
  const refreshTick = useLibraryRefresh(pollListing);

  const handleMoved = useCallback(
    async (from: string, to: string) => {
      // Follow the item: the open file, the open page and the current folder may be the one moved.
      await navigate({
        search: (previous) => ({
          dir:
            previous.dir === undefined
              ? undefined
              : remapPath(previous.dir, from, to),
          file:
            previous.file === undefined
              ? undefined
              : remapPath(previous.file, from, to),
          wiki:
            previous.wiki === undefined
              ? undefined
              : remapPath(previous.wiki, from, to),
        }),
      });
      await refresh();
    },
    [navigate, refresh]
  );

  const [newPage, setNewPage] = useState<string | null>(null);
  const startNewPage = useCallback(() => setNewPage(""), []);
  const closeNewPage = useCallback(() => setNewPage(null), []);
  const openPage = useCallback(
    async (path: string) => {
      await refresh();
      await navigate({ search: (previous) => ({ ...previous, wiki: path }) });
    },
    [navigate, refresh]
  );
  const closePage = useCallback(
    () =>
      navigate({ search: (previous) => ({ ...previous, wiki: undefined }) }),
    [navigate]
  );

  const closeFile = useCallback(
    () =>
      navigate({ search: (previous) => ({ ...previous, file: undefined }) }),
    [navigate]
  );

  const remove = useCallback(
    async (entry: LibraryEntryRecord) => {
      setBusyPath(entry.path);
      setError(null);
      try {
        await getTrpc().library.remove.mutate({
          path: entry.path,
          recursive: entry.kind === "dir",
        });
        await refresh();
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setBusyPath(null);
      }
    },
    [refresh]
  );

  return (
    <section className="mx-auto flex max-w-6xl flex-col gap-6">
      <h1 className="font-heading text-3xl text-foreground">Library</h1>
      <div className="flex flex-wrap items-start gap-6">
        <div className="flex min-w-0 flex-1 basis-52 flex-col gap-4 md:max-w-64">
          <WikiTree
            activePath={wiki}
            nodes={shown.pages}
            onNewPage={startNewPage}
          />
        </div>
        <div className="flex min-w-0 flex-[999_1_28rem] flex-col gap-6">
          {wiki === undefined ? null : (
            <WikiPageView
              key={wiki}
              onChanged={refresh}
              onClosed={closePage}
              onCreateMissing={setNewPage}
              path={wiki}
              refreshTick={refreshTick}
            />
          )}
          <h2 className="font-heading text-xl">Files</h2>
          <LibraryToolbar dir={dir} onChanged={refresh} />
          {error === null ? null : (
            <p className="text-destructive text-sm">{error}</p>
          )}
          <LibraryList
            busyPath={busyPath}
            dir={dir}
            entries={shown.entries}
            onMoved={handleMoved}
            onRemove={remove}
          />
          {file === undefined ? null : (
            <LibraryFilePanel
              key={file}
              onChanged={refresh}
              onClosed={closeFile}
              path={file}
              refreshTick={refreshTick}
            />
          )}
        </div>
      </div>
      <WikiNewPageDialog
        initialTitle={newPage ?? ""}
        nodes={shown.pages}
        onClose={closeNewPage}
        onCreated={openPage}
        open={newPage !== null}
      />
    </section>
  );
}
