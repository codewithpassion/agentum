import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { moveBlock } from "./editor-actions";

/** Block handles are view decorations; they never enter the shared schema. */
export const BlockDragHandles = Extension.create({
  addProseMirrorPlugins() {
    let dragged: string | null = null;
    return [
      new Plugin({
        props: {
          decorations: (state) => {
            if (!this.editor.isEditable) {
              return null;
            }
            const decorations: Decoration[] = [];
            state.doc.forEach((node, pos) => {
              if (!node.attrs.id) {
                return;
              }
              decorations.push(
                Decoration.widget(
                  pos,
                  () => {
                    const handle = document.createElement("button");
                    handle.type = "button";
                    handle.draggable = true;
                    handle.className = "live-block-handle";
                    handle.textContent = "⠿";
                    handle.setAttribute(
                      "aria-label",
                      `Drag ${node.type.name} block`
                    );
                    handle.setAttribute("contenteditable", "false");
                    handle.addEventListener("dragstart", (event) => {
                      dragged = node.attrs.id;
                      event.dataTransfer?.setData(
                        "application/x-harbourmaster-block",
                        String(node.attrs.id)
                      );
                      if (event.dataTransfer) {
                        event.dataTransfer.effectAllowed = "move";
                      }
                    });
                    handle.addEventListener("dragend", () => {
                      dragged = null;
                    });
                    return handle;
                  },
                  {
                    key: `handle-${node.attrs.id}`,
                    side: -1,
                    stopEvent: () => true,
                  }
                )
              );
            });
            return DecorationSet.create(state.doc, decorations);
          },
          handleDOMEvents: {
            dragover: (_view, event) => {
              if (!dragged) {
                return false;
              }
              event.preventDefault();
              return true;
            },
            drop: (view, event) => {
              if (!(dragged && this.editor.isEditable)) {
                return false;
              }
              event.preventDefault();
              const point = view.posAtCoords({
                left: event.clientX,
                top: event.clientY,
              });
              if (!point) {
                return true;
              }
              const resolved = view.state.doc.resolve(point.pos);
              const target = view.state.doc.child(resolved.index(0));
              moveBlock(this.editor, dragged, target.attrs.id);
              dragged = null;
              return true;
            },
          },
        },
      }),
    ];
  },
  name: "liveBlockDrag",
});
