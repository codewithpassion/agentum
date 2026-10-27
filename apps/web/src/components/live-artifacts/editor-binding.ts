import {
  type ContentPolicy,
  createExtensions,
  sanitizeJSON,
  schema,
} from "@repo/live-doc/schema";
import type { RelativePositionJSON } from "@repo/protocol/live";
import { Editor, Extension } from "@tiptap/core";
import { Collaboration } from "@tiptap/extension-collaboration";
import { CollaborationCaret } from "@tiptap/extension-collaboration-caret";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
  yUndoPluginKey,
  yXmlFragmentToProseMirrorRootNode,
} from "@tiptap/y-tiptap";
import type { Awareness } from "y-protocols/awareness";
import {
  createAbsolutePositionFromRelativePosition,
  createRelativePositionFromJSON,
  createRelativePositionFromTypeIndex,
  relativePositionToJSON,
  UndoManager,
} from "yjs";
import { BlockDragHandles } from "./editor-drag";
import {
  type AgentDecoration,
  canEdit,
  type DocumentEditorPorts,
  type EditorSelection,
  type PresencePort,
} from "./editor-ports";

const PEER_COLOR = /^#[\da-f]{6}$/i;
export function trustedAwareness(port: PresencePort): Awareness {
  const states = () =>
    new Map(
      [...port.awareness.getStates()].flatMap(([id, state]) => {
        const peer = port
          .getSnapshot()
          .find((person) => person.clientId === id);
        if (!(peer && PEER_COLOR.test(peer.color))) {
          return [];
        }
        return [
          [
            id,
            {
              ...state,
              user: { color: peer.color, kind: peer.kind, name: peer.name },
            },
          ] as const,
        ];
      })
    );
  return new Proxy(port.awareness, {
    get(target, key) {
      if (key === "getStates") {
        return states;
      }
      if (key === "states") {
        return states();
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
export function relativeAt(
  editor: Editor,
  pos: number,
  assoc = 0
): RelativePositionJSON {
  const sync = ySyncPluginKey.getState(editor.state);
  if (!sync?.binding) {
    throw new Error("Editor is not synchronized yet");
  }
  const position = absolutePositionToRelativePosition(
    pos,
    sync.type,
    sync.binding.mapping
  );
  const absolute = createAbsolutePositionFromRelativePosition(
    position,
    sync.doc
  );
  if (!absolute) {
    throw new Error("Cannot resolve editor selection");
  }
  return relativePositionToJSON(
    createRelativePositionFromTypeIndex(absolute.type, absolute.index, assoc)
  ) as RelativePositionJSON;
}
export function resolveRelative(
  editor: Editor,
  position: RelativePositionJSON
): number | null {
  const sync = ySyncPluginKey.getState(editor.state);
  if (!sync?.binding) {
    return null;
  }
  try {
    return relativePositionToAbsolutePosition(
      sync.doc,
      sync.type,
      createRelativePositionFromJSON(position),
      sync.binding.mapping
    );
  } catch {
    return null;
  }
}
export function selectedContext(editor: Editor): EditorSelection | undefined {
  const { from, to, empty } = editor.state.selection;
  if (empty) {
    return;
  }
  return {
    end: relativeAt(editor, to, -1),
    start: relativeAt(editor, from),
    text: editor.state.doc.textBetween(
      from,
      to,
      "\n",
      (node) => node.attrs.label ?? ""
    ),
  };
}
export const agentDecorationsKey = new PluginKey<DecorationSet>(
  "liveAgentChanges"
);
function agentDecorations() {
  return Extension.create({
    addProseMirrorPlugins() {
      return [
        new Plugin<DecorationSet>({
          key: agentDecorationsKey,
          props: {
            decorations: (state) => agentDecorationsKey.getState(state),
          },
          state: {
            apply: (tr, previous) => {
              const changes: readonly AgentDecoration[] | undefined =
                tr.getMeta(agentDecorationsKey);
              if (!changes) {
                return previous.map(tr.mapping, tr.doc);
              }
              const decorations: Decoration[] = [];
              for (const change of changes) {
                const from = resolveRelative(this.editor, change.start),
                  to = resolveRelative(this.editor, change.end);
                if (
                  from !== null &&
                  to !== null &&
                  from < to &&
                  to <= tr.doc.content.size
                ) {
                  decorations.push(
                    Decoration.inline(
                      from,
                      to,
                      {
                        class: "live-agent-change",
                        "data-change-id": change.id,
                        title: `Changed by ${change.name}`,
                      },
                      { inclusiveEnd: false, inclusiveStart: false }
                    )
                  );
                }
              }
              return DecorationSet.create(tr.doc, decorations);
            },
            init: () => DecorationSet.empty,
          },
        }),
      ];
    },
    name: "liveAgentChanges",
  });
}
/** Parent owns provider/document lifetime. No document initialization or network side effects. */
const RoleCollaboration = Collaboration.extend({
  addCommands() {
    const commands = this.parent?.();
    return {
      redo: () => (props) =>
        this.editor.isEditable && Boolean(commands?.redo?.()(props)),
      undo: () => (props) =>
        this.editor.isEditable && Boolean(commands?.undo?.()(props)),
    };
  },
});
export function createDocumentEditor(
  ports: DocumentEditorPorts,
  element?: HTMLElement
): Editor {
  if (ports.provider.awareness.doc !== ports.document) {
    throw new Error("Awareness must belong to the injected document");
  }
  const fragment = ports.document.getXmlFragment("content");
  if (fragment.length) {
    const initial = yXmlFragmentToProseMirrorRootNode(fragment, schema);
    if (
      !initial.eq(
        schema.nodeFromJSON(sanitizeJSON(initial.toJSON(), ports.policy))
      )
    ) {
      throw new Error(
        "Initial room content violates the shared content policy"
      );
    }
  }
  const awareness = trustedAwareness(ports.provider);
  const syncListeners = new Set<() => void>();
  // UniqueID listens to the provider's synced event. This component mounts only
  // after the injected port has synchronized, so deliver that event on subscribe.
  const caretProvider = {
    awareness,
    off: (_event: "synced", listener: () => void) => {
      syncListeners.delete(listener);
    },
    on: (_event: "synced", listener: () => void) => {
      syncListeners.add(listener);
      queueMicrotask(() => {
        if (syncListeners.has(listener)) {
          listener();
        }
      });
    },
  };
  const editor = new Editor({
    editable: canEdit(ports.role),
    editorProps: {
      attributes: {
        "aria-label": "Document content",
        class: "live-document-content",
      },
    },
    element: element ?? document.createElement("div"),
    extensions: [
      ...createExtensions(ports.policy),
      RoleCollaboration.configure({
        fragment: ports.document.getXmlFragment("content"),
        yUndoOptions: {
          undoManager: new UndoManager(
            ports.document.getXmlFragment("content"),
            { captureTimeout: 0, trackedOrigins: new Set([ySyncPluginKey]) }
          ),
        },
      }),
      CollaborationCaret.configure({ provider: caretProvider, user: {} }),
      agentDecorations(),
      BlockDragHandles,
      Extension.create({
        addProseMirrorPlugins() {
          return [
            new Plugin({
              filterTransaction: (tr) =>
                !tr.docChanged ||
                this.editor.isEditable ||
                Boolean(tr.getMeta(ySyncPluginKey)),
            }),
          ];
        },
        name: "liveRoleGate",
        priority: 2000,
      }),
    ],
  });
  // UniqueID repairs splits in appendTransaction, after the schema gate. Repair
  // duplicate IDs on local transactions before that gate sees the split.
  const dispatch = editor.view.props.dispatchTransaction;
  editor.view.setProps({
    dispatchTransaction: (transaction) => {
      if (transaction.docChanged && !transaction.getMeta(ySyncPluginKey)) {
        const ids = new Set<string>();
        transaction.doc.descendants((node, pos) => {
          const { id } = node.attrs;
          if (typeof id !== "string") {
            return;
          }
          if (ids.has(id)) {
            transaction.setNodeMarkup(pos, undefined, {
              ...node.attrs,
              id: crypto.randomUUID(),
            });
          } else {
            ids.add(id);
          }
        });
      }
      dispatch?.(transaction);
    },
  });
  return editor;
}
export function stopUndoGroup(editor: Editor): void {
  yUndoPluginKey.getState(editor.state)?.undoManager.stopCapturing();
}
export async function uploadEditorImage(
  editor: Editor,
  file: File,
  ports: DocumentEditorPorts,
  allowed: Set<string>
): Promise<void> {
  if (!(editor.isEditable && canEdit(ports.role))) {
    throw new Error("Editing is not permitted");
  }
  if (!file.type.startsWith("image/")) {
    throw new Error("Choose an image file");
  }
  const position = relativeAt(editor, editor.state.selection.from);
  const result = await ports.uploadImage(file);
  if (editor.isDestroyed || !editor.isEditable) {
    return;
  }
  // Only the persistence port can extend the verified own-blob set.
  const candidate: ContentPolicy = { ownBlobUrls: new Set([result.url]) };
  const clean = sanitizeJSON(
    {
      content: [{ attrs: { alt: result.alt, src: result.url }, type: "image" }],
      type: "doc",
    },
    candidate
  );
  if (clean.content?.[0]?.type !== "image") {
    throw new Error("Upload returned an invalid owned image path");
  }
  const at = resolveRelative(editor, position);
  if (at === null) {
    throw new Error("The upload insertion point was removed");
  }
  allowed.add(result.url);
  if (!editor.commands.insertContentAt(at, clean.content)) {
    throw new Error("Image could not be inserted");
  }
}
