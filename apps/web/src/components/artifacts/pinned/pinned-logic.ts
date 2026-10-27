import type { ArtifactKind } from "@repo/db/shared";

/** A pinned artifact as `artifacts.pins` returns it. */
export interface PinnedArtifact {
  artifactId: string;
  kind: ArtifactKind;
  position: number;
  title: string;
}

/** Pins in the order the person set them, oldest position first. */
export const sortPinned = (pins: readonly PinnedArtifact[]): PinnedArtifact[] =>
  [...pins].sort((a, b) => a.position - b.position);

/** Where a pinned artifact opens. A plain link: the viewer sits outside the app shell. */
export const pinnedHref = (pin: Pick<PinnedArtifact, "artifactId">): string =>
  `/a/${pin.artifactId}`;
