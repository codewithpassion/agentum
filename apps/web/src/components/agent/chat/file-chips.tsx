import { FileIcon, LibraryBig, XIcon } from "lucide-react";
import { useCallback, useState } from "react";
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
import { SaveToLibraryDialog } from "./save-to-library.tsx";

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
  agentName,
  onRemove,
}: {
  id: string;
  file: FileInfo | undefined;
  agentName?: string;
  onRemove?: (id: string) => void;
}) {
  const label = file?.name ?? "File";
  const [saveOpen, setSaveOpen] = useState(false);
  const handleRemove = useCallback(() => onRemove?.(id), [id, onRemove]);
  const handleOpenSave = useCallback(() => setSaveOpen(true), []);
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
      {file && agentName !== undefined && onRemove === undefined ? (
        <>
          <AttachmentActions>
            <AttachmentAction
              aria-label={`Save ${file.name} to library`}
              data-testid="save-to-library"
              onClick={handleOpenSave}
            >
              <LibraryBig />
            </AttachmentAction>
          </AttachmentActions>
          <SaveToLibraryDialog
            agentName={agentName}
            fileId={id}
            fileName={file.name}
            onOpenChange={setSaveOpen}
            open={saveOpen}
          />
        </>
      ) : null}
    </Attachment>
  );
}

export function FileChips({
  fileIds,
  files,
  agentName,
  onRemove,
}: {
  fileIds: readonly string[];
  files: ReadonlyMap<string, FileInfo>;
  /** Set on agent output to offer "Save to library". Not used with `onRemove`. */
  agentName?: string;
  onRemove?: (id: string) => void;
}) {
  if (fileIds.length === 0) {
    return null;
  }
  return (
    <AttachmentGroup>
      {fileIds.map((id) => (
        <FileChip
          agentName={agentName}
          file={files.get(id)}
          id={id}
          key={id}
          onRemove={onRemove}
        />
      ))}
    </AttachmentGroup>
  );
}
