import { KIND_ICONS } from "../list/kind-icons.ts";
import { type PinnedArtifact, pinnedHref, sortPinned } from "./pinned-logic.ts";

/** The "Pinned" group of the Needs you drawer. It renders nothing without pins. */
export function PinnedSidebarGroup({
  onNavigate,
  pins,
}: {
  onNavigate?: () => void;
  pins: readonly PinnedArtifact[];
}) {
  if (pins.length === 0) {
    return null;
  }
  return (
    <section data-testid="pinned-sidebar">
      <h2 className="px-2 pt-3 pb-1.5 font-medium text-[13px] text-muted-foreground">
        Pinned
      </h2>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {sortPinned(pins).map((pin) => {
          const Icon = KIND_ICONS[pin.kind];
          return (
            <li key={pin.artifactId}>
              <a
                className="flex min-h-10 items-center gap-2 rounded-md px-2 text-sm no-underline hover:bg-muted md:min-h-8 [&_svg]:size-4 [&_svg]:shrink-0"
                href={pinnedHref(pin)}
                onClick={onNavigate}
              >
                <Icon />
                <span className="truncate">{pin.title}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
