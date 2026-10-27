import { useCallback, useState } from "react";
import type { EditorSelection } from "./editor-ports";
import type { TicketedRoom } from "./room-provider";

/** Selection belongs to one accepted ask. Refreshing the transcript cannot keep
 * an already consumed cursor attached to the next ordinary message. */
export function useAgentAttachment(
  room: Pick<TicketedRoom, "clearSelection">,
  refresh: () => Promise<void>
) {
  const [selection, setSelection] = useState<EditorSelection>();
  const clear = useCallback(() => {
    setSelection(undefined);
    room.clearSelection();
  }, [room]);
  const sent = useCallback(async () => {
    clear();
    await refresh();
  }, [clear, refresh]);
  return { clear, selection, sent, setSelection };
}
