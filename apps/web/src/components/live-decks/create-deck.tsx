/** biome-ignore-all lint/performance/noJsxPropsBind: Creation uses the current title draft. */

import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { liveApi } from "../live-artifacts/live-api";
export function CreateDeck() {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const navigate = useNavigate();
  const create = async () => {
    if (busy || !title.trim()) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const result = await liveApi.createDeck.mutate({ title: title.trim() });
      await navigate({
        params: { artifactId: result.artifactId },
        to: "/a/$artifactId",
      });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not create deck"
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        create();
      }}
    >
      <label>
        Deck title
        <input
          aria-label="Deck title"
          className="block min-h-10 rounded border p-2"
          disabled={busy}
          maxLength={120}
          onChange={(event) => setTitle(event.target.value)}
          value={title}
        />
      </label>
      <button
        className="min-h-10 rounded border p-2"
        disabled={busy || !title.trim()}
        type="submit"
      >
        {busy ? "Creating deck…" : "Create deck"}
      </button>
      {Boolean(error) && <p role="alert">{error}</p>}
    </form>
  );
}
