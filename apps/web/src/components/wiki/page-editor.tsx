import type { ReactNode } from "react";
import { useCallback, useId, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import {
  Markdown,
  type MarkdownLinkProps,
} from "#/components/workspace/markdown";
import { uploadWikiAsset, type WikiAssetView } from "#/lib/api";
import { replaceWikiLinks } from "#/modules/wiki/wiki-links";

const assetMarkdown = (asset: WikiAssetView): string =>
  asset.mime.startsWith("image/")
    ? `![${asset.filename}](${asset.url})`
    : `[${asset.filename}](${asset.url})`;

/** Inserts at the caret, keeping the snippet on its own line. */
const insertAt = (body: string, caret: number, snippet: string): string => {
  const head = body.slice(0, caret);
  const tail = body.slice(caret);
  const prefix = head.length === 0 || head.endsWith("\n") ? "" : "\n";
  return `${head}${prefix}${snippet}\n${tail}`;
};

export function PageEditor({
  initialBody,
  initialTitle,
  onCancel,
  onSave,
  pageId,
  renderLink,
}: {
  initialBody: string;
  initialTitle: string;
  onCancel: () => void;
  onSave: (input: { body: string; title: string }) => Promise<void>;
  /** Absent while the page has not been created yet. */
  pageId?: string;
  renderLink: (props: MarkdownLinkProps) => ReactNode;
}) {
  const titleId = useId();
  const bodyId = useId();
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState(initialBody);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onTitleChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      setTitle(event.target.value),
    []
  );
  const onBodyChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) =>
      setBody(event.target.value),
    []
  );
  const togglePreview = useCallback(() => setPreview((on) => !on), []);
  const openFilePicker = useCallback(() => fileInputRef.current?.click(), []);

  const onFileChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) {
        return;
      }
      (async () => {
        setBusy(true);
        try {
          const asset = await uploadWikiAsset(file, pageId);
          const caret = bodyRef.current?.selectionStart ?? body.length;
          setBody((current) =>
            insertAt(
              current,
              Math.min(caret, current.length),
              assetMarkdown(asset)
            )
          );
          setError(null);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Upload failed.");
        } finally {
          setBusy(false);
        }
      })();
    },
    [body.length, pageId]
  );

  const submit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      (async () => {
        setBusy(true);
        try {
          await onSave({ body, title: title.trim() });
          setError(null);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Save failed.");
        } finally {
          setBusy(false);
        }
      })();
    },
    [body, onSave, title]
  );

  return (
    <form className="flex min-h-0 flex-1 flex-col gap-3" onSubmit={submit}>
      <div className="flex items-center gap-2">
        <label className="sr-only" htmlFor={titleId}>
          Title
        </label>
        <input
          className="ws-focus flex-1 rounded-lg border border-[var(--ws-line)] bg-[var(--ws-surface)] px-3 py-2 font-semibold text-[var(--ws-text)] text-lg"
          id={titleId}
          onChange={onTitleChange}
          placeholder="Page title"
          value={title}
        />
        <Button onClick={togglePreview} size="sm">
          {preview ? "Hide preview" : "Preview"}
        </Button>
        <Button onClick={openFilePicker} size="sm">
          Add file
        </Button>
        <input
          accept="image/*,application/pdf,text/plain,text/markdown,text/csv,application/json"
          className="sr-only"
          data-testid="wiki-file-input"
          onChange={onFileChange}
          ref={fileInputRef}
          type="file"
        />
        <Button onClick={onCancel} size="sm" variant="ghost">
          Cancel
        </Button>
        <Button
          disabled={busy || title.trim().length === 0}
          size="sm"
          type="submit"
          variant="primary"
        >
          Save
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 gap-3">
        <div className="flex min-h-0 flex-1 flex-col">
          <label className="sr-only" htmlFor={bodyId}>
            Body
          </label>
          <textarea
            className="ws-focus h-full min-h-80 w-full flex-1 resize-none rounded-lg border border-[var(--ws-line)] bg-[var(--ws-surface)] p-3 font-mono text-[13px] text-[var(--ws-text)]"
            id={bodyId}
            onChange={onBodyChange}
            placeholder="Markdown. Link another page with [[Page Title]]."
            ref={bodyRef}
            value={body}
          />
        </div>
        {preview ? (
          <div
            className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-[var(--ws-line)] bg-[var(--ws-panel)] p-3"
            data-testid="wiki-preview"
          >
            <Markdown
              anchors
              body={replaceWikiLinks(body)}
              renderLink={renderLink}
            />
          </div>
        ) : null}
      </div>

      {error ? (
        <p className="m-0 text-[var(--ws-danger)] text-xs">{error}</p>
      ) : null}
    </form>
  );
}
