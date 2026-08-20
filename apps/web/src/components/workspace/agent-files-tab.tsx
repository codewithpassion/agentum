import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import {
  breadcrumbsFor,
  type Crumb,
  joinPath,
  looksBinary,
  parentPath,
  ROOT_PATH,
} from "#/lib/agent-screen";
import type { DirEntry } from "#/lib/api";
import { formatBytes } from "#/lib/format";
import { useApi } from "#/lib/workspace-context";

/**
 * The right rail's Files tab: the agent's computer, browsable by clicking.
 * Directories descend, files preview, and the user can put a file of their own
 * into the directory that is open.
 */

const errorMessage = (cause: unknown, fallback: string): string =>
  cause instanceof Error ? cause.message : fallback;

type Preview =
  | { content: string; path: string; size: number; status: "text" }
  | { message: string; path: string; status: "unavailable" }
  | { path: string; status: "loading" };

function CrumbButton({
  crumb,
  onOpen,
}: {
  crumb: Crumb;
  onOpen: (path: string) => void;
}) {
  const open = useCallback(() => onOpen(crumb.path), [crumb.path, onOpen]);
  return (
    <button
      className="ws-focus max-w-24 shrink-0 truncate rounded px-1 text-[var(--ws-muted)] text-xs hover:text-[var(--ws-text)]"
      onClick={open}
      type="button"
    >
      {crumb.label}
    </button>
  );
}

function EntryRow({
  entry,
  onOpen,
}: {
  entry: DirEntry;
  onOpen: (entry: DirEntry) => void;
}) {
  const open = useCallback(() => onOpen(entry), [entry, onOpen]);
  return (
    <li>
      <button
        className="ws-focus flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-[var(--ws-surface-hover)]"
        onClick={open}
        type="button"
      >
        <span aria-hidden="true">{entry.directory ? "📁" : "📄"}</span>
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        {entry.directory ? null : (
          <span className="text-[10px] text-[var(--ws-muted)]">
            {formatBytes(entry.size)}
          </span>
        )}
      </button>
    </li>
  );
}

function PreviewPanel({
  agentId,
  onClose,
  preview,
}: {
  agentId: string;
  onClose: () => void;
  preview: Preview;
}) {
  const api = useApi();

  return (
    <section
      className="space-y-1.5 rounded-lg border border-[var(--ws-line)] bg-[var(--ws-bg)] p-2"
      data-testid="agent-file-preview"
    >
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate text-[11px] text-[var(--ws-muted)]">
          {preview.path}
        </code>
        <Button
          aria-label="Close preview"
          onClick={onClose}
          size="icon"
          variant="ghost"
        >
          <span aria-hidden="true">✕</span>
        </Button>
      </div>

      {preview.status === "loading" ? (
        <p className="m-0 text-[var(--ws-muted)] text-xs">Loading…</p>
      ) : null}

      {preview.status === "text" ? (
        <pre className="m-0 max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-5">
          {preview.content}
        </pre>
      ) : null}

      {preview.status === "unavailable" ? (
        <div className="space-y-1.5">
          <p className="m-0 text-[var(--ws-muted)] text-xs leading-5">
            {preview.message}
          </p>
          <a
            className="inline-block rounded-lg border border-[var(--ws-line)] bg-[var(--ws-surface)] px-2 py-1 text-[var(--ws-text)] text-xs no-underline"
            download
            href={api.computerFileUrl(agentId, preview.path)}
          >
            Download
          </a>
        </div>
      ) : null}
    </section>
  );
}

export function AgentFilesTab({ agentId }: { agentId: string }) {
  const api = useApi();

  const [path, setPath] = useState<string>(ROOT_PATH);
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      setEntries(await api.listComputerDir(agentId, path));
      setError(null);
    } catch (cause) {
      setEntries(null);
      setError(errorMessage(cause, "Could not read that directory."));
    }
  }, [agentId, api, path]);

  useEffect(() => {
    load();
  }, [load]);

  const openPath = useCallback((next: string) => {
    setPath(next);
    setPreview(null);
  }, []);

  const goUp = useCallback(() => openPath(parentPath(path)), [openPath, path]);

  const openEntry = useCallback(
    async (entry: DirEntry) => {
      const target = joinPath(path, entry.name);
      if (entry.directory) {
        openPath(target);
        return;
      }

      setPreview({ path: target, status: "loading" });
      try {
        const file = await api.readComputerFile(agentId, target);
        setPreview(
          looksBinary(file.content)
            ? {
                message: "This file is not text, so it cannot be shown here.",
                path: target,
                status: "unavailable",
              }
            : {
                content: file.content,
                path: target,
                size: file.size,
                status: "text",
              }
        );
      } catch (cause) {
        setPreview({
          message: errorMessage(cause, "This file could not be read."),
          path: target,
          status: "unavailable",
        });
      }
    },
    [agentId, api, openPath, path]
  );

  const closePreview = useCallback(() => setPreview(null), []);
  const openFilePicker = useCallback(() => fileInputRef.current?.click(), []);

  const onFilePicked = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) {
        return;
      }
      setBusy(true);
      api
        .uploadComputerFile(agentId, file, joinPath(path, file.name))
        .then(load)
        .catch((cause: unknown) => {
          setError(errorMessage(cause, "The upload failed."));
        })
        .finally(() => setBusy(false));
    },
    [agentId, api, load, path]
  );

  const crumbs = breadcrumbsFor(path);

  return (
    <div className="space-y-2" data-testid="agent-files">
      <div className="flex items-center gap-1">
        <nav
          aria-label="Path"
          className="flex min-w-0 flex-1 items-center overflow-x-auto"
        >
          {crumbs.map((crumb, index) => (
            <span className="flex items-center" key={crumb.path}>
              {/* The root crumb is already a slash, so it separates itself. */}
              {index > 1 ? (
                <span
                  aria-hidden="true"
                  className="text-[10px] text-[var(--ws-muted)]"
                >
                  /
                </span>
              ) : null}
              <CrumbButton crumb={crumb} onOpen={openPath} />
            </span>
          ))}
        </nav>
        {path === ROOT_PATH ? null : (
          <Button onClick={goUp} size="sm" variant="ghost">
            Up
          </Button>
        )}
        <input
          className="hidden"
          data-testid="agent-file-upload"
          onChange={onFilePicked}
          ref={fileInputRef}
          type="file"
        />
        <Button
          disabled={busy}
          onClick={openFilePicker}
          size="sm"
          variant="subtle"
        >
          Upload
        </Button>
      </div>

      {error ? (
        <p className="m-0 text-[var(--ws-danger)] text-xs leading-5">{error}</p>
      ) : null}

      {entries === null && !error ? (
        <p className="m-0 text-[var(--ws-muted)] text-xs">Loading…</p>
      ) : null}

      {entries?.length === 0 ? (
        <p
          className="m-0 text-[var(--ws-muted)] text-xs leading-5"
          data-testid="agent-files-empty"
        >
          This folder is empty. Upload a file to put one on the agent's
          computer.
        </p>
      ) : null}

      {entries && entries.length > 0 ? (
        <ul className="m-0 list-none space-y-0.5 p-0">
          {entries.map((entry) => (
            <EntryRow entry={entry} key={entry.name} onOpen={openEntry} />
          ))}
        </ul>
      ) : null}

      {preview ? (
        <PreviewPanel
          agentId={agentId}
          onClose={closePreview}
          preview={preview}
        />
      ) : null}
    </div>
  );
}
