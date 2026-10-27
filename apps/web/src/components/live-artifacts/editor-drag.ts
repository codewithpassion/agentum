import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { moveBlock } from "./editor-actions";

/** Block handles are view decorations; they never enter the shared schema. */
export const BlockDragHandles = Extension.create({
  addProseMirrorPlugins() {
    let dragged: string | null = null;
    const dropAt = (view: EditorView, x: number, y: number, source: string) => {
      const point = view.posAtCoords({ left: x, top: y });
      if (!point) {
        return;
      }
      const resolved = view.state.doc.resolve(point.pos);
      const index = Math.min(resolved.index(0), view.state.doc.childCount - 1);
      if (index < 0) {
        return;
      }
      let pos = 0;
      for (let i = 0; i < index; i += 1) {
        pos += view.state.doc.child(i).nodeSize;
      }
      const dom = view.nodeDOM(pos);
      const rect = dom instanceof Element ? dom.getBoundingClientRect() : null;
      const after = rect && y > rect.top + rect.height / 2;
      const target = view.state.doc.maybeChild(index + (after ? 1 : 0));
      moveBlock(this.editor, source, target?.attrs.id ?? null);
    };
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
                    handle.addEventListener("keydown", (event) => {
                      const blocks: string[] = [];
                      for (
                        let index = 0;
                        index < this.editor.state.doc.childCount;
                        index += 1
                      ) {
                        blocks.push(
                          this.editor.state.doc.child(index).attrs.id
                        );
                      }
                      const index = blocks.indexOf(node.attrs.id);
                      if (event.key === "ArrowUp" && index > 0) {
                        event.preventDefault();
                        moveBlock(
                          this.editor,
                          node.attrs.id,
                          blocks[index - 1] ?? null
                        );
                      }
                      if (
                        event.key === "ArrowDown" &&
                        index < blocks.length - 1
                      ) {
                        event.preventDefault();
                        moveBlock(
                          this.editor,
                          node.attrs.id,
                          blocks[index + 2] ?? null
                        );
                      }
                    });
                    let touchStart = 0;
                    handle.addEventListener("pointerdown", (event) => {
                      if (event.pointerType === "touch") {
                        touchStart = event.clientY;
                        handle.setPointerCapture(event.pointerId);
                      }
                    });
                    handle.addEventListener("pointerup", (event) => {
                      if (
                        event.pointerType === "touch" &&
                        Math.abs(event.clientY - touchStart) > 8
                      ) {
                        dropAt(
                          this.editor.view,
                          event.clientX,
                          event.clientY,
                          node.attrs.id
                        );
                      }
                    });
                    handle.addEventListener("dragend", () => {
                      dragged = null;
                    });
                    return handle;
                  },
                  {
                    key: `handle-${node.type.name}-${node.attrs.id}`,
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
              dropAt(view, event.clientX, event.clientY, dragged);
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
