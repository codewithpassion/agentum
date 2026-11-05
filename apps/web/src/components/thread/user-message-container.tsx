import { MessagePrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { PencilIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { Bubble, BubbleContent } from "#/components/ui/bubble.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Message, MessageContent } from "#/components/ui/message.tsx";
import { FileChips } from "./file-chips.tsx";
import { RunMarker } from "./run-marker.tsx";
import { ThreadAuthor } from "./thread-author.tsx";
import { OutsideInput } from "./thread-cards.tsx";
import { useThreadEnv } from "./thread-context.tsx";

const ID_SEPARATOR = "\u0000";

/** A user turn, with its files, an "edited" mark, and "Edit and resend" on the latest one. */
export function UserMessageContainer() {
  const aui = useAui();
  const { edited, editableId, files, outsideLabels, memberLabels, active } =
    useThreadEnv();
  const authorLabel = useAuiState(
    (state) => state.message.metadata.custom.authorLabel
  );
  const id = useAuiState((state) => state.message.id);
  const text = useAuiState((state) =>
    state.message.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n")
  );
  const joinedIds = useAuiState((state) =>
    (state.message.attachments ?? []).map((item) => item.id).join(ID_SEPARATOR)
  );
  const fileIds = useMemo(
    () => (joinedIds === "" ? [] : joinedIds.split(ID_SEPARATOR)),
    [joinedIds]
  );
  const edit = useCallback(() => aui.message().composer().beginEdit(), [aui]);
  return (
    <MessagePrimitive.Root data-role="user">
      <RunMarker>
        <Message align="end">
          <MessageContent>
            {outsideLabels?.has(id) ? null : (
              <ThreadAuthor label={memberLabels?.get(id) ?? authorLabel} />
            )}
            {outsideLabels?.has(id) ? (
              <OutsideInput label={outsideLabels.get(id) ?? "Outside input"}>
                {text}
              </OutsideInput>
            ) : (
              <Bubble align="end">
                <BubbleContent className="whitespace-pre-wrap">
                  {text}
                </BubbleContent>
              </Bubble>
            )}
            {fileIds.length === 0 ? null : (
              <div className="flex justify-end">
                <FileChips fileIds={fileIds} files={files} />
              </div>
            )}
            <div className="flex items-center justify-end gap-2 text-muted-foreground text-xs">
              {edited.has(id) ? (
                <span data-testid="edited-mark">
                  Edited. The agent still remembers this message.
                </span>
              ) : null}
              {editableId === id && !outsideLabels?.has(id) ? (
                <Button
                  className="min-h-10 md:min-h-9"
                  data-testid="edit-message"
                  onClick={edit}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <PencilIcon aria-hidden="true" />
                  <span className="md:hidden">Edit</span>
                  <span className="hidden md:inline">
                    Edit and resend{active ? " (stops the agent)" : ""}
                  </span>
                </Button>
              ) : null}
            </div>
          </MessageContent>
        </Message>
      </RunMarker>
    </MessagePrimitive.Root>
  );
}
