import { FileIcon, XIcon } from "lucide-react";
import { useCallback } from "react";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from "#/components/ui/attachment.tsx";
import type { FileInfo } from "#/integrations/trpc/types.ts";

const UNITS = ["KB", "MB", "GB"];
const KIBI = 1024;

function formatBytes(bytes: number): string {
  if (bytes < KIBI) {
    return `${bytes} B`;
  }
  let value = bytes / KIBI;
  let unit = 0;
  while (Number(value.toFixed(1)) >= KIBI && unit < UNITS.length - 1) {
    value /= KIBI;
    unit += 1;
  }
  return `${value.toFixed(1)} ${UNITS[unit]}`;
}

function FileChip({
  id,
  file,
  onRemove,
}: {
  id: string;
  file: FileInfo | undefined;
  onRemove?: (id: string) => void;
}) {
  const label = file?.name ?? "File";
  const handleRemove = useCallback(() => onRemove?.(id), [id, onRemove]);
  return (
    <Attachment size="sm">
      {file ? (
        <AttachmentTrigger asChild>
          <a href={`/files/${id}`} rel="noreferrer" target="_blank">
            <span className="sr-only">{file.name}</span>
          </a>
        </AttachmentTrigger>
      ) : null}
      <AttachmentMedia>
        <FileIcon />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{label}</AttachmentTitle>
        {file ? (
          <AttachmentDescription>
            {formatBytes(file.size)}
          </AttachmentDescription>
        ) : null}
      </AttachmentContent>
      {onRemove ? (
        <AttachmentActions>
          <AttachmentAction
            aria-label={`Remove ${label}`}
            onClick={handleRemove}
          >
            <XIcon />
          </AttachmentAction>
        </AttachmentActions>
      ) : null}
    </Attachment>
  );
}

export function FileChips({
  fileIds,
  files,
  onRemove,
}: {
  fileIds: readonly string[];
  files: ReadonlyMap<string, FileInfo>;
  onRemove?: (id: string) => void;
}) {
  if (fileIds.length === 0) {
    return null;
  }
  return (
    <AttachmentGroup>
      {fileIds.map((id) => (
        <FileChip file={files.get(id)} id={id} key={id} onRemove={onRemove} />
      ))}
    </AttachmentGroup>
  );
}
