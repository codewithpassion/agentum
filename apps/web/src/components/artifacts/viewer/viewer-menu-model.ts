export type PinSurface = "desk" | "sidebar";

interface PinRow {
  artifactId: string;
  surface: PinSurface;
}

/** The surfaces this artifact is pinned on, out of the caller's pins. */
export function pinnedSurfaces(
  pins: readonly PinRow[],
  artifactId: string
): ReadonlySet<PinSurface> {
  return new Set(
    pins
      .filter((pin) => pin.artifactId === artifactId)
      .map((pin) => pin.surface)
  );
}

/** "Pin to sidebar" / "Unpin from sidebar". */
export function pinMenuLabel(surface: PinSurface, pinned: boolean): string {
  return pinned ? `Unpin from ${surface}` : `Pin to ${surface}`;
}

/** The set after pinning or unpinning one surface. The input is not changed. */
export function togglePinned(
  pinned: ReadonlySet<PinSurface>,
  surface: PinSurface
): ReadonlySet<PinSurface> {
  const next = new Set(pinned);
  if (next.has(surface)) {
    next.delete(surface);
  } else {
    next.add(surface);
  }
  return next;
}

/** The toast after a toggle: `pinned` is the new state. */
export function pinToast(surface: PinSurface, pinned: boolean): string {
  return pinned ? `Pinned to ${surface}` : `Unpinned from ${surface}`;
}
