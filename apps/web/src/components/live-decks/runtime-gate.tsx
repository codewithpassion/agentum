import { DeckEditor } from "./deck-editor";
import type { DeckEditorPorts } from "./ports";

export type DeckRuntime =
  | { state: "loading"; message?: string }
  | { state: "unavailable"; message: string }
  | { state: "ready"; ports: DeckEditorPorts };

/** Route/room wiring is a separate integration gate. Never construct an offline fake provider here. */
export function DeckRuntimeGate({ runtime }: { runtime: DeckRuntime }) {
  if (
    runtime.state === "ready" &&
    !runtime.ports.deck.doc.getMap("meta").has("theme")
  ) {
    return (
      <div role="alert">
        Deck initialization is incomplete: the room must initialize the shared
        theme before editing.
      </div>
    );
  }
  if (runtime.state === "ready") {
    return <DeckEditor key={runtime.ports.selfId} ports={runtime.ports} />;
  }
  return (
    <div role={runtime.state === "unavailable" ? "alert" : "status"}>
      {runtime.message ?? "Connecting to the deck room…"}
    </div>
  );
}
