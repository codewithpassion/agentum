import { type RefObject, useCallback, useState } from "react";
import type { MapTool, PaletteItem } from "./editor-logic.ts";
import { agentIdOf } from "./map-logic.ts";

/**
 * Tap-to-plug for touch screens, where HTML5 drag and drop does not fire. A
 * tap on a palette tool picks it, and the next tap on an agent plugs it in.
 * Any other tap selects as usual.
 */
export function useTapToPlug({
  boardRef,
  plug,
  select,
}: {
  boardRef: RefObject<HTMLElement | null>;
  plug: (agentId: string, tool: MapTool) => void;
  select: (key: string | null) => void;
}) {
  const [picked, setPicked] = useState<PaletteItem | null>(null);
  /** Picking brings the map into view, since the palette sits below it on a phone. */
  const pickTool = useCallback(
    (item: PaletteItem | null) => {
      setPicked(item);
      if (item !== null) {
        boardRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      }
    },
    [boardRef]
  );
  const clearPick = useCallback(() => setPicked(null), []);
  const selectNode = useCallback(
    (key: string | null) => {
      const agentId = key === null ? null : agentIdOf(key);
      if (picked !== null && agentId !== null) {
        plug(agentId, picked.tool);
        setPicked(null);
        return;
      }
      select(key);
    },
    [picked, plug, select]
  );
  return { cancelPick: clearPick, clearPick, picked, pickTool, selectNode };
}
