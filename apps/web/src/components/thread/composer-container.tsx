import {
  AttachmentPrimitive,
  ComposerPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import { INPUT_FILES_MAX, MAX_FILE_BYTES } from "@repo/db/shared";
import { FileIcon, XIcon } from "lucide-react";
import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { dictationAdapter } from "#/components/composer/dictation-adapter.ts";
import { SendHint } from "#/components/composer/send-hint.tsx";
import { submitOnSendShortcut } from "#/components/composer/send-shortcut.ts";
import {
  DictationButton,
  DictationPreview,
  useDictation,
} from "#/components/dictation/index.ts";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "#/components/ui/attachment.tsx";
import { Button } from "#/components/ui/button.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import { libraryAttachment } from "./attachment-adapter.ts";
import { LibraryPicker } from "./library-picker.tsx";

/** What the composer allows: the limit `startRun` enforces. */
const MAX_ATTACHMENTS = INPUT_FILES_MAX;
const BYTES_PER_MB = 1024 * 1024;

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

function ComposerAttachment() {
  const name = useAuiState((state) => state.attachment.name);
  const uploading = useAuiState(
    (state) => state.attachment.status.type === "running"
  );
  return (
    <Attachment size="sm">
      <AttachmentMedia>
        <FileIcon />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{name}</AttachmentTitle>
        {uploading ? (
          <AttachmentDescription>Uploading</AttachmentDescription>
        ) : null}
      </AttachmentContent>
      <AttachmentActions>
        <AttachmentPrimitive.Remove asChild>
          <AttachmentAction aria-label={`Remove ${name}`}>
            <XIcon />
          </AttachmentAction>
        </AttachmentPrimitive.Remove>
      </AttachmentActions>
    </Attachment>
  );
}

/**
 * The message box under the thread. Send is Ctrl or Cmd+Enter, and files come
 * from the disk or the library. `disabledNote` turns the box off and says why.
 */
export function ComposerContainer({
  disabledNote,
}: {
  disabledNote: string | null;
}) {
  const aui = useAui();
  const count = useAuiState((state) => state.composer.attachments.length);
  const uploading = useAuiState((state) =>
    state.composer.attachments.some((item) => item.status.type === "running")
  );
  const empty = useAuiState((state) => state.composer.text.trim() === "");
  const [pickerOpen, setPickerOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const disabled = disabledNote !== null;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const dictation = useDictation({
    adapter: dictationAdapter,
    disabled,
    getValue: () => aui.composer().getState().text,
    inputRef,
    setValue: (value) => aui.composer().setText(value),
  });

  const addFiles = useCallback(
    async (picked: File[]) => {
      const room = Math.max(MAX_ATTACHMENTS - count, 0);
      const withinCount = picked.slice(0, room);
      const accepted = withinCount.filter(
        (file) => file.size <= MAX_FILE_BYTES
      );
      if (picked.length > withinCount.length) {
        toast.error(`You can attach up to ${MAX_ATTACHMENTS} files.`);
      }
      if (accepted.length < withinCount.length) {
        toast.error(
          `Files are limited to ${MAX_FILE_BYTES / BYTES_PER_MB} MB.`
        );
      }
      await Promise.all(
        accepted.map(async (file) => {
          try {
            await aui.composer().addAttachment(file);
          } catch (cause) {
            toast.error(messageOf(cause));
          }
        })
      );
    },
    [aui, count]
  );

  const handleFiles = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const picked = Array.from(event.target.files ?? []);
      // Clear the value so picking the same file again fires a change.
      event.target.value = "";
      if (picked.length > 0) {
        addFiles(picked);
      }
    },
    [addFiles]
  );

  // A message needs text: `runs.start` refuses an empty one, and files alone would be lost.
  const blockEmpty = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      if (empty || dictation.busy) {
        event.preventDefault();
      }
    },
    [empty, dictation.busy]
  );

  const openFiles = useCallback(() => fileInputRef.current?.click(), []);
  const openLibrary = useCallback(() => setPickerOpen(true), []);
  const closeLibrary = useCallback(() => setPickerOpen(false), []);

  const attachFromLibrary = useCallback(
    async (path: string) => {
      setPickerOpen(false);
      if (count >= MAX_ATTACHMENTS) {
        toast.error(`You can attach up to ${MAX_ATTACHMENTS} files.`);
        return;
      }
      try {
        const info = await getTrpc().files.attachFromLibrary.mutate({ path });
        await aui.composer().addAttachment(libraryAttachment(info));
      } catch (cause) {
        toast.error(messageOf(cause));
      }
    },
    [aui, count]
  );

  return (
    <ComposerPrimitive.Root
      className="flex flex-col gap-2"
      onSubmit={blockEmpty}
    >
      <div className="relative">
        <ComposerPrimitive.Input
          aria-describedby="thread-send-hint"
          aria-label="Message"
          className="field-sizing-content max-h-48 min-h-16 w-full resize-none rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={disabled}
          onKeyDown={submitOnSendShortcut}
          placeholder="Write to the agent"
          readOnly={dictation.busy}
          ref={inputRef}
          submitMode="none"
        />
        <DictationPreview dictation={dictation} />
      </div>
      {count === 0 ? null : (
        <AttachmentGroup>
          <ComposerPrimitive.Attachments
            components={{ Attachment: ComposerAttachment }}
          />
        </AttachmentGroup>
      )}
      {disabledNote === null ? null : (
        <p className="text-muted-foreground text-sm" role="status">
          {disabledNote}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="Attach files"
          className="sr-only"
          disabled={disabled}
          multiple
          onChange={handleFiles}
          ref={fileInputRef}
          tabIndex={-1}
          type="file"
        />
        <Button
          disabled={disabled}
          onClick={openFiles}
          size="sm"
          type="button"
          variant="outline"
        >
          Attach files
        </Button>
        <Button
          data-testid="library-picker-open"
          disabled={disabled}
          onClick={openLibrary}
          size="sm"
          type="button"
          variant="outline"
        >
          From library
        </Button>
        <DictationButton dictation={dictation} />
        <ComposerPrimitive.Send asChild>
          <Button
            disabled={disabled || empty || uploading || dictation.busy}
            size="sm"
            type="submit"
          >
            Send
          </Button>
        </ComposerPrimitive.Send>
        <SendHint id="thread-send-hint" />
      </div>
      {pickerOpen ? (
        <LibraryPicker onClose={closeLibrary} onPick={attachFromLibrary} />
      ) : null}
    </ComposerPrimitive.Root>
  );
}
