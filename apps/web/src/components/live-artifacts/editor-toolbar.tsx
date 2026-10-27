/** biome-ignore-all lint/performance/noJsxPropsBind: Small editor controls capture the command and its current selection. */
import { THEME_COLORS } from "@repo/live-doc/schema";
import type { Editor } from "@tiptap/core";
import { type ReactNode, useId, useState } from "react";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import {
  applyBlock,
  blockActions,
  changeCase,
  setEditorLink,
  setThemeColor,
} from "./editor-actions";
import type { TrustedParticipant } from "./editor-ports";

export function ToolButton({
  children,
  ...props
}: React.ComponentProps<typeof Button>) {
  return (
    <Button
      type="button"
      variant="ghost"
      {...props}
      className="min-h-10 min-w-10"
      onMouseDown={(event) => event.preventDefault()}
    >
      {children}
    </Button>
  );
}
function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="live-tools-group">
      <summary>{label}</summary>
      <div className="live-tools-items">{children}</div>
    </details>
  );
}
export function EditorToolbar({
  editor,
  participants,
  upload,
  importImage,
  report,
}: {
  editor: Editor;
  participants: readonly TrustedParticipant[];
  importImage?: (url: string) => Promise<void>;
  upload: (file: File) => Promise<void>;
  report: (error: unknown) => void;
}) {
  const linkId = useId();
  const dateId = useId();
  const [imageUrl, setImageUrl] = useState("");
  const [link, setLink] = useState("");
  const [date, setDate] = useState("");
  return (
    <fieldset aria-label="Document formatting" className="live-toolbar">
      <ToolButton
        disabled={!(editor.isEditable && editor.can().undo())}
        onClick={() => editor.commands.undo()}
      >
        Undo
      </ToolButton>
      <ToolButton
        disabled={!(editor.isEditable && editor.can().redo())}
        onClick={() => editor.commands.redo()}
      >
        Redo
      </ToolButton>
      {editor.isEditable === true && (
        <>
          <Group label="Text">
            {(["bold", "italic", "underline", "strike", "code"] as const).map(
              (mark) => (
                <ToolButton
                  aria-pressed={editor.isActive(mark)}
                  key={mark}
                  onClick={() => editor.chain().focus().toggleMark(mark).run()}
                >
                  {
                    {
                      bold: "Bold",
                      code: "Inline code",
                      italic: "Italic",
                      strike: "Strikethrough",
                      underline: "Underline",
                    }[mark]
                  }
                </ToolButton>
              )
            )}
            <ToolButton
              onClick={() =>
                editor.chain().focus().unsetAllMarks().clearNodes().run()
              }
            >
              Clear formatting
            </ToolButton>
            <label htmlFor={linkId}>
              Link
              <Input
                aria-label="Link URL"
                id={linkId}
                onChange={(event) => setLink(event.target.value)}
                placeholder="https:// or /path"
                value={link}
              />
            </label>
            <ToolButton
              onClick={() => {
                if (!setEditorLink(editor, link)) {
                  report(new Error("Enter a safe HTTP, mailto or local link"));
                }
              }}
            >
              Apply link
            </ToolButton>
            <ToolButton onClick={() => setEditorLink(editor, "")}>
              Remove link
            </ToolButton>
            <fieldset aria-label="Text colour" className="live-swatches">
              {THEME_COLORS.map((color) => (
                <ToolButton
                  aria-label={`Text colour ${color}`}
                  key={color}
                  onClick={() => setThemeColor(editor, color)}
                  style={{
                    backgroundColor:
                      color === "#ffffff" ? "#111827" : undefined,
                    color,
                  }}
                >
                  A
                </ToolButton>
              ))}
            </fieldset>
          </Group>
          <Group label="Case">
            {(["upper", "lower", "title", "sentence"] as const).map((mode) => (
              <ToolButton
                disabled={editor.state.selection.empty}
                key={mode}
                onClick={() => changeCase(editor, mode)}
              >
                {
                  {
                    lower: "lower case",
                    sentence: "Sentence case",
                    title: "Title Case",
                    upper: "UPPER CASE",
                  }[mode]
                }
              </ToolButton>
            ))}
          </Group>
          <Group label="Blocks">
            {blockActions.map((action) => (
              <ToolButton
                key={action}
                onClick={() => applyBlock(editor, action)}
              >
                {action}
              </ToolButton>
            ))}
          </Group>
          <Group label="Table">
            <ToolButton onClick={() => applyBlock(editor, "Table")}>
              Insert table
            </ToolButton>
            {(
              [
                [
                  "Add row above",
                  () => editor.chain().focus().addRowBefore().run(),
                ],
                [
                  "Add row below",
                  () => editor.chain().focus().addRowAfter().run(),
                ],
                ["Remove row", () => editor.chain().focus().deleteRow().run()],
                [
                  "Add column before",
                  () => editor.chain().focus().addColumnBefore().run(),
                ],
                [
                  "Add column after",
                  () => editor.chain().focus().addColumnAfter().run(),
                ],
                [
                  "Remove column",
                  () => editor.chain().focus().deleteColumn().run(),
                ],
                [
                  "Header row",
                  () => editor.chain().focus().toggleHeaderRow().run(),
                ],
                [
                  "Remove table",
                  () => editor.chain().focus().deleteTable().run(),
                ],
              ] as const
            ).map(([label, action]) => (
              <ToolButton
                disabled={!editor.isActive("table")}
                key={label}
                onClick={action}
              >
                {label}
              </ToolButton>
            ))}
            <fieldset aria-label="Cell colour" className="live-swatches">
              {THEME_COLORS.map((color) => (
                <ToolButton
                  aria-label={`Cell colour ${color}`}
                  disabled={!editor.isActive("table")}
                  key={color}
                  onClick={() => setThemeColor(editor, color, true)}
                  style={{
                    backgroundColor: color,
                    border: "1px solid #9ca3af",
                  }}
                />
              ))}
            </fieldset>
          </Group>
          <Group label="Insert">
            {importImage !== undefined && (
              <label>
                Image URL
                <input
                  aria-label="Image URL"
                  onChange={(event) => setImageUrl(event.target.value)}
                  placeholder="HTTPS image from Unsplash, Wikimedia or Pexels"
                  type="url"
                  value={imageUrl}
                />
                <ToolButton
                  disabled={!imageUrl}
                  onClick={() => {
                    importImage(imageUrl)
                      .then(() => setImageUrl(""))
                      .catch(report);
                  }}
                >
                  Insert image URL
                </ToolButton>
              </label>
            )}
            <label className="live-upload">
              Upload image
              <input
                accept="image/*"
                aria-label="Upload image"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    upload(file).catch(report);
                  }
                  event.target.value = "";
                }}
                type="file"
              />
            </label>
            <label>
              Mention
              <select
                aria-label="Mention a person"
                defaultValue=""
                onChange={(event) => {
                  const person = participants.find(
                    (peer) => peer.id === event.target.value
                  );
                  if (person) {
                    editor
                      .chain()
                      .focus()
                      .insertContent({
                        attrs: { label: `@${person.name}`, value: person.id },
                        type: "mention",
                      })
                      .run();
                  }
                  event.target.value = "";
                }}
              >
                <option disabled value="">
                  Choose a person
                </option>
                {participants.map((peer) => (
                  <option key={peer.clientId} value={peer.id}>
                    {peer.name}
                  </option>
                ))}
              </select>
            </label>
            <label htmlFor={dateId}>
              Date
              <Input
                aria-label="Date chip"
                id={dateId}
                onChange={(event) => setDate(event.target.value)}
                type="date"
                value={date}
              />
            </label>
            <ToolButton
              disabled={!date}
              onClick={() =>
                editor
                  .chain()
                  .focus()
                  .insertContent({
                    attrs: { label: date, value: date },
                    type: "date",
                  })
                  .run()
              }
            >
              Insert date
            </ToolButton>
          </Group>
        </>
      )}
    </fieldset>
  );
}
