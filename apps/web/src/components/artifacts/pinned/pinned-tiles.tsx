import { KIND_ICONS } from "../list/kind-icons.ts";
import { type PinnedArtifact, pinnedHref, sortPinned } from "./pinned-logic.ts";

/** Pinned artifacts as tiles at the top of the desk. Renders nothing without pins. */
export function PinnedDeskTiles({ pins }: { pins: readonly PinnedArtifact[] }) {
  if (pins.length === 0) {
    return null;
  }
  return (
    <section
      aria-label="Pinned artifacts"
      className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3"
      data-testid="pinned-desk-tiles"
    >
      {sortPinned(pins).map((pin) => {
        const Icon = KIND_ICONS[pin.kind];
        return (
          <a
            className="flex min-h-16 min-w-0 items-center gap-3 rounded-lg border bg-card p-3 text-card-foreground transition-colors hover:bg-muted/50"
            data-testid="pinned-desk-tile"
            href={pinnedHref(pin)}
            key={pin.artifactId}
          >
            <Icon className="size-5 shrink-0 text-muted-foreground" />
            <span className="truncate font-medium text-sm">{pin.title}</span>
          </a>
        );
      })}
    </section>
  );
}
