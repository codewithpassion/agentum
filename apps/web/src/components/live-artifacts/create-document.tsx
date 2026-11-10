/** biome-ignore-all lint/performance/noJsxPropsBind: Creation uses the current title draft. */

import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { errorMessage } from "#/lib/error-message";
import { liveApi } from "./live-api";

interface CreateDocumentFormProps {
  create: (title: string) => Promise<{ artifactId: string }>;
  open: (artifactId: string) => Promise<unknown> | unknown;
}

/** Creates the document, then opens it. Returns the failure message, if any. */
export async function createAndOpenDocument(
  { create, open }: CreateDocumentFormProps,
  title: string
): Promise<string | undefined> {
  try {
    const result = await create(title.trim());
    await open(result.artifactId);
  } catch (cause) {
    return errorMessage(cause, "Could not create document");
  }
}

export function CreateDocumentForm(props: CreateDocumentFormProps) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async () => {
    if (busy || !title.trim()) {
      return;
    }
    setBusy(true);
    setError(undefined);
    setError(await createAndOpenDocument(props, title));
    setBusy(false);
  };
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label>
        Document title
        <input
          aria-label="Document title"
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
        {busy ? "Creating document…" : "Create document"}
      </button>
      {Boolean(error) && <p role="alert">{error}</p>}
    </form>
  );
}

export function CreateDocument() {
  const navigate = useNavigate();
  return (
    <CreateDocumentForm
      create={(title) => liveApi.createDocument.mutate({ title })}
      open={(artifactId) =>
        navigate({ params: { artifactId }, to: "/a/$artifactId" })
      }
    />
  );
}
