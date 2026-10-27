import type {
  ArtifactCard,
  ArtifactsListOutput,
} from "@repo/protocol/artifacts";
import { Boxes } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty.tsx";
import { ArtifactCardView } from "./artifact-card.tsx";
import { type ArtifactFilters, hasFilters } from "./artifacts-logic.ts";

/** Adds a fetched page to the shown cards, skipping any card already shown. */
export const appendPage = (
  items: readonly ArtifactCard[],
  page: readonly ArtifactCard[]
): ArtifactCard[] => {
  const seen = new Set(items.map((item) => item.artifactId));
  const fresh: ArtifactCard[] = [];
  for (const card of page) {
    if (!seen.has(card.artifactId)) {
      seen.add(card.artifactId);
      fresh.push(card);
    }
  }
  return [...items, ...fresh];
};

export interface ArtifactsGridProps {
  filters: ArtifactFilters;
  initial: ArtifactsListOutput;
  loadMore: (cursor: string) => Promise<ArtifactsListOutput>;
  nowMs: number | null;
}

export function ArtifactsGrid({
  filters,
  initial,
  loadMore,
  nowMs,
}: ArtifactsGridProps) {
  const [items, setItems] = useState(initial.items);
  const [next, setNext] = useState(initial.next);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const onMore = useCallback(async () => {
    if (next === undefined) {
      return;
    }
    setLoading(true);
    setFailed(false);
    try {
      const page = await loadMore(next);
      setItems((current) => appendPage(current, page.items));
      setNext(page.next);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [loadMore, next]);

  if (items.length === 0) {
    const filtered = hasFilters(filters);
    return (
      <Empty data-testid="artifacts-empty">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Boxes />
          </EmptyMedia>
          <EmptyTitle>
            {filtered
              ? "No artifacts match these filters."
              : "No artifacts yet."}
          </EmptyTitle>
          {filtered ? null : (
            <EmptyDescription>
              Agents publish pages, docs and dashboards here, and they appear in
              this list.
            </EmptyDescription>
          )}
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <ul
        className="grid grid-cols-1 gap-2 md:grid-cols-2 md:gap-4 xl:grid-cols-3"
        data-testid="artifacts-grid"
      >
        {items.map((card) => (
          <li className="min-w-0" key={card.artifactId}>
            <ArtifactCardView card={card} nowMs={nowMs} />
          </li>
        ))}
      </ul>
      {failed ? (
        <p className="text-destructive text-sm" role="alert">
          Could not load more artifacts. Try again.
        </p>
      ) : null}
      {next === undefined ? null : (
        <Button
          className="min-h-10 self-center"
          data-testid="artifacts-more"
          disabled={loading}
          onClick={onMore}
          variant="outline"
        >
          {loading ? "Loading..." : "Load more"}
        </Button>
      )}
    </div>
  );
}
