/** biome-ignore-all lint/performance/noJsxPropsBind: Decisions capture one durable suggestion id. */
import type { GuestSuggestionsResult } from "@repo/protocol/guest";
import { useCallback, useEffect, useState } from "react";
import type { EditorRole } from "../live-artifacts/editor-ports";
import { guestHttp } from "./http";
import type { GuestServices } from "./services";

/** Guest reads and decisions share the host-wide rotating-cookie queue with
 * room admission, comments, transcript and images. Role comes from the room. */
export function GuestSuggestions({
  services,
  role,
  failed,
}: {
  services: GuestServices;
  role: EditorRole;
  failed: (message: string) => void;
}) {
  const [data, setData] = useState<GuestSuggestionsResult>();
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setData(
        await guestHttp.json<GuestSuggestionsResult>(
          services.endpoint("suggestions")
        )
      );
    } catch (cause) {
      failed(
        cause instanceof Error ? cause.message : "Suggestions unavailable"
      );
    }
  }, [services, failed]);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);
  const decide = async (
    suggestionId: string,
    decision: "accept" | "reject"
  ) => {
    if (busy || role !== "editor") {
      return;
    }
    setBusy(true);
    try {
      setData(
        await guestHttp.json<GuestSuggestionsResult>(
          services.endpoint("decide-suggestion"),
          { decision, suggestionId }
        )
      );
    } catch (cause) {
      failed(cause instanceof Error ? cause.message : "Decision failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      aria-label="Agent suggestions"
      className="guest-comments guest-suggestions"
    >
      <h2>Agent suggestions</h2>
      <p>
        Guest-triggered agent edits require review. Your own edits apply
        directly.
      </p>
      {!data && <p role="status">Loading suggestions…</p>}
      {data?.items.length === 0 && <p>No suggestions yet.</p>}
      {data?.items.map((item) => (
        <article aria-label={`Suggestion ${item.id}`} key={item.id}>
          <p>
            {item.authorName} · <strong>{item.status}</strong> ·{" "}
            <time dateTime={item.createdAt}>{item.createdAt}</time>
          </p>
          <details>
            <summary>Preview {item.kind} suggestion</summary>
            <pre>{item.preview}</pre>
          </details>
          {Boolean(item.conflict) && (
            <p role="alert">
              Conflict: {item.conflict}. Ask for a new suggestion.
            </p>
          )}
          {Boolean(item.decidedBy) && <p>Reviewed by {item.decidedBy}</p>}
          {role === "editor" && item.status === "pending" && (
            <div className="guest-suggestion-actions">
              <button
                disabled={busy}
                onClick={() => decide(item.id, "accept")}
                type="button"
              >
                Accept suggestion
              </button>
              <button
                disabled={busy}
                onClick={() => decide(item.id, "reject")}
                type="button"
              >
                Reject suggestion
              </button>
            </div>
          )}
        </article>
      ))}
    </section>
  );
}
