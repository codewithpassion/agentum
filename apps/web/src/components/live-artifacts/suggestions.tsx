/** biome-ignore-all lint/performance/noJsxPropsBind: Review actions capture one suggestion. */

import { useCallback, useEffect, useRef, useState } from "react";
import { startPolling } from "#/components/inbox/use-polled-query";
import { errorMessage } from "#/lib/error-message";
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
  const generation = useRef(0);
  const mutating = useRef<boolean>(false);
  const refresh = useCallback(async () => {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Event callbacks mutate this ref between requests.
    if (mutating.current) {
      return;
    }
    generation.current += 1;
    const request = generation.current;
    try {
      const result = await liveApi.suggestions.query({ artifactId });
      if (request === generation.current) {
        setData(result);
      }
    } catch (cause) {
      if (request === generation.current) {
        setError(errorMessage(cause, "Suggestions unavailable"));
      }
    }
  }, [artifactId]);
  useEffect(() => {
    refresh();
    const stop = startPolling(refresh, 5000);
    return () => {
      stop();
      generation.current += 1;
      mutating.current = false;
    };
  }, [refresh]);
  const act = async (work: () => Promise<LiveOutputs["suggestions"]>) => {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Event callbacks mutate this ref between requests.
    if (mutating.current) {
      return;
    }
    mutating.current = true;
    generation.current += 1;
    const request = generation.current;
    setBusy(true);
    setError(undefined);
    try {
      const result = await work();
      if (request === generation.current) {
        setData(result);
      }
    } catch (cause) {
      if (request === generation.current) {
        setError(errorMessage(cause, "Decision failed"));
      }
    } finally {
      if (request === generation.current) {
        mutating.current = false;
        setBusy(false);
      }
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
