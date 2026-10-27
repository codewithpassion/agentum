import type { ArtifactKind } from "@repo/db/shared";
import type { ArtifactCard } from "@repo/protocol/artifacts";
import {
  AppWindow,
  BookOpen,
  FileText,
  LayoutDashboard,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { SlotCard } from "#/components/task/slots.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import { artifactHref, audienceBadges } from "./artifacts-logic.ts";

/** How often the artifacts slot reads the list again while the run is going. */
export const ARTIFACTS_REFRESH_MS = 5000;

const KIND_ICONS: Record<ArtifactKind, LucideIcon> = {
  app: AppWindow,
  dashboard: LayoutDashboard,
  doc: BookOpen,
  page: FileText,
};

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

/**
 * The artifacts slot of the task view: what the run made. It reads
 * `artifacts.list` on mount, every 5 s while the run is running, and once more
 * when it stops running. It stays out of the way while there is nothing to show.
 */
export function ArtifactsSlot({
  runId,
  running,
}: {
  runId: string;
  running: boolean;
}) {
  const [cards, setCards] = useState<readonly ArtifactCard[]>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    const load = async () => {
      try {
        const result = await getTrpc().artifacts.list.query({ runId });
        if (current) {
          setCards(result.items);
          setMore(result.next !== undefined);
          setError(null);
        }
      } catch (cause) {
        if (current) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    };
    load();
    if (!running) {
      return () => {
        current = false;
      };
    }
    const timer = setInterval(load, ARTIFACTS_REFRESH_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [runId, running]);

  if (cards.length === 0 && error === null) {
    return null;
  }

  return (
    <SlotCard testId="slot-artifacts" title="Artifacts">
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      <ArtifactSlotRows cards={cards} />
      {more ? (
        <a className="text-muted-foreground text-sm" href="/artifacts">
          and more in Artifacts
        </a>
      ) : null}
    </SlotCard>
  );
}
