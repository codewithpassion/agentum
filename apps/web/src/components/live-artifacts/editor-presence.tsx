/** biome-ignore-all lint/performance/noJsxPropsBind: Small editor controls capture the command and its current selection. */
import type { RelativePositionJSON } from "@repo/protocol/live";
import type { Editor } from "@tiptap/core";
import { yCursorPluginKey } from "@tiptap/y-tiptap";
import { useEffect, useState, useSyncExternalStore } from "react";
import { resolveRelative } from "./editor-binding";
import { AGENT_PRESENCE_TTL_MS, type PresencePort } from "./editor-ports";
import { ToolButton } from "./editor-toolbar";

const PEER_COLOR = /^#[\da-f]{6}$/i;
export function EditorPresence({
  editor,
  port,
}: {
  editor: Editor | null;
  port: PresencePort;
}) {
  const participants = useSyncExternalStore(
    port.subscribe,
    port.getSnapshot,
    port.getSnapshot
  );
  const [following, setFollowing] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const refresh = () => {
      setNow(Date.now());
      if (editor && !editor.isDestroyed) {
        editor.view.dispatch(
          editor.state.tr.setMeta(yCursorPluginKey, { awarenessUpdated: true })
        );
      }
    };
    const unsubscribe = port.subscribe(refresh);
    const timer = setInterval(refresh, 500);
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, [editor, port]);
  useEffect(() => {
    if (!editor || following === null) {
      return;
    }
    const follow = () => {
      const peer = port
        .getSnapshot()
        .find((person) => person.clientId === following);
      if (!peer) {
        setFollowing(null);
        return;
      }
      const cursor = port.awareness.getStates().get(following)?.cursor;
      if (!cursor?.head) {
        return;
      }
      const pos = resolveRelative(editor, cursor.head as RelativePositionJSON);
      if (pos === null || pos < 0 || pos > editor.state.doc.content.size) {
        return;
      }
      const { node } = editor.view.domAtPos(pos);
      (node instanceof Element ? node : node.parentElement)?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    };
    const stop = () => setFollowing(null);
    follow();
    port.awareness.on("change", follow);
    const unsubscribe = port.subscribe(follow);
    // Wheel/touch/scroll keys indicate own navigation; scroll events alone also
    // fire for scrollIntoView and therefore cannot distinguish the follower.
    window.addEventListener("wheel", stop, { passive: true });
    window.addEventListener("touchmove", stop, { passive: true });
    const onPointer = (event: PointerEvent) => {
      if (
        !(
          event.target instanceof Element &&
          event.target.closest(".live-avatars")
        )
      ) {
        stop();
      }
    };
    window.addEventListener("pointerdown", onPointer);
    const onKey = (event: KeyboardEvent) => {
      if (
        [
          "PageDown",
          "PageUp",
          "Home",
          "End",
          "ArrowDown",
          "ArrowUp",
          " ",
        ].includes(event.key)
      ) {
        stop();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      port.awareness.off("change", follow);
      unsubscribe();
      window.removeEventListener("wheel", stop);
      window.removeEventListener("touchmove", stop);
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [editor, following, port]);
  return (
    <div className="live-presence">
      <fieldset aria-label="Participants" className="live-avatars">
        {participants.map((peer) => (
          <ToolButton
            aria-label={`${following === peer.clientId ? "Stop following" : "Follow"} ${peer.name} (${peer.kind})`}
            aria-pressed={following === peer.clientId}
            disabled={peer.clientId === port.awareness.clientID}
            key={peer.clientId}
            onClick={() =>
              setFollowing((value) =>
                value === peer.clientId ? null : peer.clientId
              )
            }
            style={{
              borderColor: PEER_COLOR.test(peer.color) ? peer.color : "#6b7280",
              borderWidth: 2,
            }}
            title={`${peer.name} · ${peer.kind}`}
          >
            {peer.name}
            <small>{peer.kind}</small>
          </ToolButton>
        ))}
      </fieldset>
      <div aria-live="polite" role="status">
        {participants
          .filter(
            (peer) =>
              peer.kind === "agent" &&
              peer.status &&
              now - peer.status.updatedAt < AGENT_PRESENCE_TTL_MS
          )
          .map((peer) => (
            <p key={peer.clientId}>
              {peer.name}: {peer.status?.text}
            </p>
          ))}
      </div>
      {following !== null && (
        <p>
          Following{" "}
          {participants.find((peer) => peer.clientId === following)?.name}.
          Scroll or click to stop.
        </p>
      )}
    </div>
  );
}
