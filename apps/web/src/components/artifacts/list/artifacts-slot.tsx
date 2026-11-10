import type { ArtifactCard } from "@repo/protocol/artifacts";
import { useEffect, useState } from "react";
import { startPolling } from "#/components/inbox/use-polled-query";
import { getTrpc } from "#/integrations/trpc/client";
import { errorMessage } from "#/lib/error-message";
import { artifactHref, audienceBadges } from "./artifacts-logic.ts";
import { KIND_ICONS } from "./kind-icons.ts";

/** How often the artifacts slot reads the list again while the run is going. */
export const ARTIFACTS_REFRESH_MS = 5000;

/** The rows of the slot, one link per artifact. Renders nothing for no cards. */
export function ArtifactSlotRows({
  cards,
}: {
  cards: readonly ArtifactCard[];
}) {
  return cards.map((card) => {
    const Icon = KIND_ICONS[card.kind];
    const [badge] = audienceBadges(card);
    return (
      <a
        className="flex min-h-10 items-center gap-2 rounded-md px-1 text-sm hover:bg-muted"
        data-testid="slot-artifact"
        href={artifactHref(card.artifactId)}
        key={card.artifactId}
      >
        <Icon aria-hidden="true" className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{card.title}</span>
        <span className="shrink-0 text-muted-foreground text-xs">
          v{card.currentVersion}
        </span>
        {badge === undefined ? null : (
          <span className="shrink-0 text-muted-foreground text-xs">
            {badge}
          </span>
        )}
      </a>
    );
  });
}

/** Follow cursors so the Files count and rows cover every artifact of this run. */
async function loadRunArtifacts(
  runId: string,
  cursor?: string,
  cards: ArtifactCard[] = []
): Promise<ArtifactCard[]> {
  const page = await getTrpc().artifacts.list.query({
    runId,
    ...(cursor === undefined ? {} : { cursor }),
  });
  cards.push(...page.items);
  return page.next === undefined
    ? cards
    : loadRunArtifacts(runId, page.next, cards);
}

/**
 * The artifacts slot of the task view: what the run made. It reads
 * `artifacts.list` on mount, every 5 s while the run is running, and once more
 * when it stops running. It stays out of the way while there is nothing to show.
 */
export function ArtifactsSlot({
  runId,
  running,
  onCount,
}: {
  runId: string;
  running: boolean;
  onCount?: (count: number) => void;
}) {
  const [cards, setCards] = useState<readonly ArtifactCard[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    const load = async () => {
      try {
        const nextCards = await loadRunArtifacts(runId);
        if (current) {
          setCards(nextCards);
          onCount?.(nextCards.length);
          setError(null);
        }
      } catch (cause) {
        if (current) {
          setError(errorMessage(cause));
        }
      }
    };
    load();
    if (!running) {
      return () => {
        current = false;
      };
    }
    const stop = startPolling(load, ARTIFACTS_REFRESH_MS);
    return () => {
      current = false;
      stop();
    };
  }, [runId, running, onCount]);

  if (cards.length === 0 && error === null) {
    return null;
  }

  return (
    <section className="flex flex-col gap-3" data-testid="slot-artifacts">
      <h2 className="font-medium">Artifacts</h2>
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      <ArtifactSlotRows cards={cards} />
    </section>
  );
}
