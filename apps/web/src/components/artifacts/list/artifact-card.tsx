import type { ArtifactCard } from "@repo/protocol/artifacts";
import { elapsedText } from "#/components/desk/desk-logic.ts";
import { Badge } from "#/components/ui/badge.tsx";
import { cn } from "#/lib/utils.ts";
import {
  artifactHref,
  audienceBadges,
  byLine,
  thumbnailSrc,
} from "./artifacts-logic.ts";
import { KIND_ICONS } from "./kind-icons.ts";

export interface ArtifactCardViewProps {
  card: ArtifactCard;
  /** Null before hydration: the time then shows as a date so server and browser markup match. */
  nowMs: number | null;
}

export function ArtifactCardView({ card, nowMs }: ArtifactCardViewProps) {
  const Icon = KIND_ICONS[card.kind];
  const updated =
    nowMs === null
      ? card.updatedAt.slice(0, 10)
      : elapsedText(card.updatedAt, nowMs);
  return (
    <a
      className={cn(
        "flex min-h-16 min-w-0 items-center gap-3 rounded-lg border bg-card p-2 text-card-foreground transition-colors hover:bg-muted/50",
        "md:flex-col md:items-stretch md:gap-3 md:p-3"
      )}
      data-testid="artifact-card"
      href={artifactHref(card.artifactId)}
    >
      <div
        className={cn(
          "flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-muted-foreground",
          "md:aspect-video md:size-auto md:w-full"
        )}
      >
        {card.hasThumbnail ? (
          <img
            alt=""
            className="size-full object-cover"
            height={224}
            loading="lazy"
            src={thumbnailSrc(card.artifactId)}
            width={400}
          />
        ) : (
          <Icon className="size-6 md:size-8" data-testid="artifact-kind-icon" />
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate font-medium text-sm">{card.title}</span>
        <span className="truncate text-muted-foreground text-xs">
          {byLine(card)}
        </span>
        <span className="truncate text-muted-foreground text-xs">
          {`v${card.currentVersion} · ${updated}`}
        </span>
        <div className="flex flex-wrap gap-1">
          {audienceBadges(card).map((label) => (
            <Badge
              data-testid="artifact-audience"
              key={label}
              variant={label === "Link" ? "secondary" : "outline"}
            >
              {label}
            </Badge>
          ))}
        </div>
      </div>
    </a>
  );
}
