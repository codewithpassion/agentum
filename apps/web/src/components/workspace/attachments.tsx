import type { AttachmentView } from "#/lib/api";
import { formatBytes, isImage } from "#/lib/format";

export function AttachmentList({
  attachments,
}: {
  attachments: AttachmentView[];
}) {
  if (attachments.length === 0) {
    return null;
  }

  return (
    <ul className="m-0 mt-2 flex list-none flex-col gap-2 p-0">
      {attachments.map((attachment) => (
        <li key={attachment.id}>
          {isImage(attachment.mime) ? (
            <a href={attachment.url} rel="noopener noreferrer" target="_blank">
              {/* biome-ignore lint/correctness/useImageSize: uploads carry no stored dimensions; CSS bounds the render box */}
              <img
                alt={attachment.filename}
                className="max-h-80 max-w-full rounded-xl border border-[var(--ws-line)]"
                src={attachment.url}
              />
            </a>
          ) : (
            <a
              className="inline-flex items-center gap-2 rounded-lg border border-[var(--ws-line)] bg-[var(--ws-bg)] px-2.5 py-1.5 text-[var(--ws-text)] text-xs no-underline"
              download={attachment.filename}
              href={attachment.url}
            >
              <span aria-hidden="true">📄</span>
              <span className="font-medium">{attachment.filename}</span>
              <span className="text-[var(--ws-muted)]">
                {formatBytes(attachment.size)}
              </span>
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}
