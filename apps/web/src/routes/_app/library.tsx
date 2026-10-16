import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { useCallback, useState } from "react";
import { z } from "zod";
import { LibraryFilePanel } from "#/components/library/library-file-panel";
import { LibraryList } from "#/components/library/library-list";
import { errorMessage } from "#/components/library/library-logic";
import { LibraryToolbar } from "#/components/library/library-toolbar";
import { getTrpc } from "#/integrations/trpc/client";
import type { LibraryEntryRecord } from "#/integrations/trpc/types";

const searchSchema = z.object({
  dir: z.string().min(1).optional().catch(undefined),
  file: z.string().min(1).optional().catch(undefined),
});

export const Route = createFileRoute("/_app/library")({
  validateSearch: (search) => searchSchema.parse(search),
  loaderDeps: ({ search }) => ({ dir: search.dir ?? "" }),
  loader: async ({ deps }) => {
    try {
      return {
        entries: await getTrpc().library.list.query({ dir: deps.dir }),
      };
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
  const { entries } = Route.useLoaderData();
  const { dir = "", file } = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => router.invalidate(), [router]);

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
    <section className="mx-auto flex max-w-5xl flex-col gap-6">
      <h1 className="font-heading text-3xl text-foreground">Library</h1>
      <LibraryToolbar dir={dir} onChanged={refresh} />
      {error === null ? null : (
        <p className="text-destructive text-sm">{error}</p>
      )}
      <LibraryList
        busyPath={busyPath}
        dir={dir}
        entries={entries}
        onRemove={remove}
      />
      {file === undefined ? null : (
        <LibraryFilePanel
          key={file}
          onChanged={refresh}
          onClosed={closeFile}
          path={file}
        />
      )}
    </section>
  );
}
