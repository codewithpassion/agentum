/** biome-ignore-all lint/performance/noJsxPropsBind: Review actions capture one suggestion. */
import { useCallback, useEffect, useState } from "react";
import { ToolButton } from "./editor-toolbar";
import { type LiveOutputs, liveApi } from "./live-api";

/** Shared by mounted document and deck collaboration sheets. Preview is text. */
export function Suggestions({
  artifactId,
  canEdit,
}: {
  artifactId: string;
  canEdit: boolean;
}) {
  const [data, setData] = useState<LiveOutputs["suggestions"]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setData(await liveApi.suggestions.query({ artifactId }));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Suggestions unavailable"
      );
    }
  }, [artifactId]);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);
  const act = async (work: () => Promise<LiveOutputs["suggestions"]>) => {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      setData(await work());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Decision failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Agent suggestions">
      <h3>Agent suggestions</h3>
      <label>
        <input
          checked={data?.mode ?? false}
          disabled={!canEdit || busy || !data}
          onChange={(event) =>
            act(() =>
              liveApi.setSuggestionMode.mutate({
                artifactId,
                enabled: event.target.checked,
              })
            )
          }
          type="checkbox"
        />
        Require suggestions for agent edits in this artifact
      </label>
      <p>
        Guest-triggered agent edits always require review. Human edits apply
        directly.
      </p>
      {Boolean(error) && (
        <p role="alert">
          {error}
          <ToolButton onClick={refresh}>Refresh suggestions</ToolButton>
        </p>
      )}
      {data?.items.length === 0 && <p>No suggestions yet.</p>}
      {data?.items.map((item) => (
        <article aria-label={`Suggestion by ${item.authorName}`} key={item.id}>
          <p>
            {item.authorName} · {item.status} ·{" "}
            <time dateTime={item.createdAt}>{item.createdAt}</time>
          </p>
          <details>
            <summary>Preview {item.kind} suggestion</summary>
            <pre
              style={{
                maxHeight: "20rem",
                overflow: "auto",
                overflowWrap: "anywhere",
                whiteSpace: "pre-wrap",
              }}
            >
              {item.preview}
            </pre>
          </details>
          {Boolean(item.conflict) && (
            <p role="alert">
              Conflict: {item.conflict}. Ask the agent for a new suggestion.
            </p>
          )}
          {Boolean(item.decidedBy) && <p>Reviewed by {item.decidedBy}</p>}
          {canEdit && item.status === "pending" && (
            <div>
              <ToolButton
                disabled={busy}
                onClick={() =>
                  act(() =>
                    liveApi.decideSuggestion.mutate({
                      artifactId,
                      decision: "accept",
                      suggestionId: item.id,
                    })
                  )
                }
              >
                Accept suggestion
              </ToolButton>
              <ToolButton
                disabled={busy}
                onClick={() =>
                  act(() =>
                    liveApi.decideSuggestion.mutate({
                      artifactId,
                      decision: "reject",
                      suggestionId: item.id,
                    })
                  )
                }
              >
                Reject suggestion
              </ToolButton>
            </div>
          )}
        </article>
      ))}
    </section>
  );
}
