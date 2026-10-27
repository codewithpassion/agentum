/** biome-ignore-all lint/performance/noJsxPropsBind: Export actions capture the selected format. */
import { useEffect, useRef, useState } from "react";
import { type DownloadFormat, prepareDownload, saveDownload } from "./download";

export function ExportControls({
  artifactId,
  kind,
  connected,
}: {
  artifactId: string;
  kind: "document" | "deck";
  connected: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [prepared, setPrepared] =
    useState<Awaited<ReturnType<typeof prepareDownload>>>();
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (!connected) {
      request.current?.abort();
      setPrepared(undefined);
    }
  }, [connected]);
  const prepare = async (format: DownloadFormat) => {
    if (busy || !connected) {
      return;
    }
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(undefined);
    setPrepared(undefined);
    try {
      const result = await prepareDownload(
        artifactId,
        format,
        controller.signal
      );
      if (!controller.signal.aborted) {
        setPrepared(result);
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : "Export failed");
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Export downloads">
      <p>
        Export accepted room content. Changes still syncing may be absent. Your
        editor stays open.
      </p>
      <p>
        Only this artifact’s images are included. Unsupported media can prevent
        export. Office layout, fonts and interactive content may differ; review
        warnings before downloading.
      </p>
      <button
        disabled={busy || !connected}
        onClick={() => prepare(kind === "deck" ? "pptx" : "docx")}
        type="button"
      >
        {kind === "deck" ? "Export PowerPoint (.pptx)" : "Export Word (.docx)"}
      </button>
      <button
        disabled={busy || !connected}
        onClick={() => prepare("pdf")}
        type="button"
      >
        Export PDF
      </button>
      {busy === true && <p role="status">Preparing export…</p>}
      {error !== undefined && <p role="alert">{error}</p>}
      {prepared !== undefined && (
        <section aria-label="Review export" role="dialog">
          <p>
            Ready: {prepared.filename}, accepted revision {prepared.revision}.
          </p>
          {prepared.warnings.length ? (
            <ul>
              {prepared.warnings.map((warning) => (
                <li key={`${warning.code}:${warning.path}:${warning.detail}`}>
                  {warning.detail} ({warning.path}; {warning.code})
                </li>
              ))}
            </ul>
          ) : (
            <p>No format warnings reported.</p>
          )}
          <button
            onClick={() => {
              saveDownload(prepared.blob, prepared.filename);
              setPrepared(undefined);
            }}
            type="button"
          >
            Download reviewed export
          </button>
          <button onClick={() => setPrepared(undefined)} type="button">
            Cancel export
          </button>
        </section>
      )}
    </section>
  );
}
