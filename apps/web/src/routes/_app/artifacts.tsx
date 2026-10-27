import { ARTIFACT_KINDS } from "@repo/db/shared";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { useCallback } from "react";
import { z } from "zod";
import { ArtifactsFilters } from "#/components/artifacts/list/artifacts-filters.tsx";
import { ArtifactsGrid } from "#/components/artifacts/list/artifacts-grid.tsx";
import {
  type ArtifactFilters,
  listInput,
} from "#/components/artifacts/list/artifacts-logic.ts";
import { CreateDeck } from "#/components/live-decks/create-deck";
import { useNowMs } from "#/components/task/use-now-ms.ts";
import { getTrpc } from "#/integrations/trpc/client";

const searchSchema = z.object({
  kind: z.enum(ARTIFACT_KINDS).optional().catch(undefined),
  madeBy: z.enum(["agent", "person"]).optional().catch(undefined),
  shared: z.literal(true).optional().catch(undefined),
});

export const Route = createFileRoute("/_app/artifacts")({
  validateSearch: (search) => searchSchema.parse(search),
  loaderDeps: ({ search }) => ({
    kind: search.kind,
    madeBy: search.madeBy,
    shared: search.shared,
  }),
  loader: async ({ deps }) => {
    try {
      return await getTrpc().artifacts.list.query(listInput(deps));
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
  component: ArtifactsPage,
});

function ArtifactsPage() {
  const initial = Route.useLoaderData();
  const filters: ArtifactFilters = Route.useSearch();
  const navigate = Route.useNavigate();
  const nowMs = useNowMs();

  const changeFilters = useCallback(
    (patch: Partial<ArtifactFilters>) =>
      navigate({ search: (previous) => ({ ...previous, ...patch }) }),
    [navigate]
  );
  const loadMore = useCallback(
    (cursor: string) =>
      getTrpc().artifacts.list.query(listInput(filters, cursor)),
    [filters]
  );

  return (
    <section className="mx-auto flex max-w-6xl flex-col gap-6">
      <h1 className="font-heading text-3xl text-foreground">Artifacts</h1>
      <CreateDeck />
      <ArtifactsFilters filters={filters} onChange={changeFilters} />
      <ArtifactsGrid
        filters={filters}
        initial={initial}
        key={`${filters.kind ?? ""}|${filters.madeBy ?? ""}|${filters.shared ?? ""}`}
        loadMore={loadMore}
        nowMs={nowMs}
      />
    </section>
  );
}
