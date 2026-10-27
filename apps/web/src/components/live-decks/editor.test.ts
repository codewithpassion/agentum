import { afterAll, beforeAll, expect, test } from "bun:test";
import { Deck } from "@repo/live-deck";
import { richTextCodec } from "@repo/live-deck/rich-text";
import { Editor } from "@tiptap/core";
import { Window } from "happy-dom";
import { Doc, encodeStateAsUpdate, encodeStateVector } from "yjs";
import { scenePoint, transformPatches } from "./geometry";
import {
  buildSteps,
  DeckCommands,
  emptySlide,
  groupSelection,
  newElement,
  patchNotes,
  ungroupSelection,
} from "./model";
import type { DeckEditorPorts } from "./ports";
import { deckTextExtensions } from "./rich-text";

const window = new Window();
const previous = new Map<string, PropertyDescriptor | undefined>();
beforeAll(() => {
  for (const key of [
    "window",
    "document",
    "navigator",
    "Node",
    "Element",
    "HTMLElement",
    "MutationObserver",
    "DOMParser",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
  ]) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const value = Reflect.get(window, key);
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value:
        typeof value === "function" && key[0] === key[0]?.toLowerCase()
          ? value.bind(window)
          : value,
    });
  }
});
afterAll(() => {
  for (const [key, descriptor] of previous) {
    if (descriptor) {
      Object.defineProperty(globalThis, key, descriptor);
    } else {
      Reflect.deleteProperty(globalThis, key);
    }
  }
  window.happyDOM.abort();
});
function fixture() {
  const deck = new Deck(new Doc(), richTextCodec);
  deck.setTheme({ colors: {}, fonts: {}, sizes: {} });
  const slide = emptySlide(deck);
  deck.addSlide(slide);
  const text = newElement(slide, "text");
  deck.addElement(slide.id, text);
  const table = newElement(slide, "table");
  deck.addElement(slide.id, table);
  const ports = {
    deck,
    provider: { state: "synced" },
    role: "editor",
  } as DeckEditorPorts;
  const commands = new DeckCommands(() => ports);
  const remote = new Deck(new Doc(), richTextCodec);
  remote.applyUpdate(encodeStateAsUpdate(deck.doc));
  return {
    commands,
    deck,
    destroy() {
      commands.destroy();
      deck.destroy();
      remote.destroy();
      deck.doc.destroy();
      remote.doc.destroy();
    },
    ports,
    remote,
    slide,
    table,
    text,
  };
}
test("scene per-key concurrent edits converge; own undo keeps remote changes and fragment identity", () => {
  const f = fixture();
  try {
    const fragment = f.deck.textFragment(f.slide.id, f.text.id);
    f.commands.run((deck) =>
      deck.setElementKey(f.slide.id, f.text.id, "style", "color", "#ef4444")
    );
    f.remote.setElementKey(f.slide.id, f.text.id, "style", "font-size", "42px");
    f.deck.applyUpdate(encodeStateAsUpdate(f.remote.doc));
    f.remote.applyUpdate(encodeStateAsUpdate(f.deck.doc));
    expect(f.deck.read(f.slide.id).slide).toEqual(
      f.remote.read(f.slide.id).slide
    );
    expect(f.commands.undo.undoStack).toHaveLength(1);
    f.commands.undo.undo();
    expect(
      f.deck.read(f.slide.id).slide.elements.find((e) => e.id === f.text.id)
        ?.style
    ).toEqual({ color: "#111827", "font-size": "42px" });
    expect(f.deck.textFragment(f.slide.id, f.text.id)).toBe(fragment);
    f.ports.role = "viewer";
    expect(() =>
      f.commands.run((deck) => deck.deleteSlide(f.slide.id))
    ).toThrow("editor role");
  } finally {
    f.destroy();
  }
});
test("actual Tiptap bindings merge independent text and table cell edits through core admission", () => {
  const f = fixture();
  const editors: Editor[] = [];
  try {
    const cell = f.deck.cellFragment(f.slide.id, f.table.id, "0:0");
    f.remote.applyUpdate(encodeStateAsUpdate(f.deck.doc));
    const a = new Editor({
      extensions: deckTextExtensions(
        f.deck.textFragment(f.slide.id, f.text.id)
      ),
    });
    const b = new Editor({
      extensions: deckTextExtensions(
        f.remote.textFragment(f.slide.id, f.text.id)
      ),
    });
    const c = new Editor({ extensions: deckTextExtensions(cell) });
    editors.push(a, b, c);
    a.commands.insertContentAt(1, "Alice ");
    b.commands.insertContentAt(1, "Bob ");
    c.commands.insertContentAt(1, "Cell");
    f.deck.applyUpdate(encodeStateAsUpdate(f.remote.doc));
    f.remote.applyUpdate(encodeStateAsUpdate(f.deck.doc));
    expect(a.getText()).toContain("Alice");
    expect(a.getText()).toContain("Bob");
    expect(a.getText()).toBe(b.getText());
    expect(
      f.remote.read(f.slide.id).slide.elements.find((e) => e.id === f.table.id)
        ?.cells?.["0:0"]
    ).toEqual(
      richTextCodec.serialize(cell).filter((node) => typeof node !== "string")
    );
    const before = b.getText();
    a.commands.undo();
    f.remote.applyUpdate(encodeStateAsUpdate(f.deck.doc));
    expect(b.getText()).toContain("Bob");
    expect(b.getText()).not.toContain("Alice");
    expect(b.getText()).not.toBe(before);
  } finally {
    for (const editor of editors) {
      editor.destroy();
    }
    f.destroy();
  }
});
test("deck Tiptap subset refuses document-only blocks and unsafe links without publishing", () => {
  const f = fixture();
  const editor = new Editor({
    extensions: deckTextExtensions(f.deck.textFragment(f.slide.id, f.text.id)),
  });
  try {
    const before = encodeStateVector(f.deck.doc);
    editor.commands.setContent({
      content: [
        {
          attrs: { level: 1 },
          content: [{ text: "Forbidden", type: "text" }],
          type: "heading",
        },
      ],
      type: "doc",
    });
    expect(encodeStateVector(f.deck.doc)).toEqual(before);
    editor.commands.setContent({
      content: [
        {
          content: [
            {
              marks: [{ attrs: { href: "javascript:alert(1)" }, type: "link" }],
              text: "Forbidden",
              type: "text",
            },
          ],
          type: "paragraph",
        },
      ],
      type: "doc",
    });
    expect(editor.getText()).toBe("Edit text");
    f.deck.validate();
  } finally {
    editor.destroy();
    f.destroy();
  }
});
test("notes retain Y.Text and invalid XML is refused; slide moves and groups stay unique", () => {
  const f = fixture();
  try {
    const notes = (
      f.deck.doc.getMap("slides").get(f.slide.id) as import("yjs").Map<unknown>
    ).get("notes");
    f.commands.run((deck) => patchNotes(deck, f.slide.id, "Speaker notes"));
    expect(
      (
        f.deck.doc
          .getMap("slides")
          .get(f.slide.id) as import("yjs").Map<unknown>
      ).get("notes")
    ).toBe(notes);
    expect(() =>
      f.commands.run((deck) => patchNotes(deck, f.slide.id, "\u0000"))
    ).toThrow();
    const second = emptySlide(f.deck);
    f.commands.run((deck) => deck.addSlide(second));
    f.commands.run((deck) => deck.moveSlide(second.id, null, f.slide.id));
    expect(f.deck.ids()).toEqual([second.id, f.slide.id]);
    const group = newElement(f.deck.read(f.slide.id).slide, "group");
    f.commands.run((deck) =>
      deck.groupElements(f.slide.id, group, [f.text.id, f.table.id])
    );
    expect(
      f.deck
        .read(f.slide.id)
        .slide.elements.filter((e) => e.parent === group.id)
    ).toHaveLength(2);
    f.commands.run((deck) => deck.ungroupElements(f.slide.id, group.id));
    f.deck.validate();
  } finally {
    f.destroy();
  }
});
test("build order makes withPrevious share a click and afterPrevious a timed step", () => {
  const f = fixture();
  try {
    const { slide } = f.deck.read(f.slide.id);
    const [first, second] = slide.elements;
    if (!(first && second)) {
      throw new Error("fixture elements missing");
    }
    first.props = {
      ...first.props,
      "build-in": "fade",
      "build-order": "1",
      "build-trigger": "click",
    };
    second.props = {
      ...second.props,
      "build-in": "rise",
      "build-order": "2",
      "build-trigger": "withPrevious",
    };
    expect(buildSteps(slide)).toHaveLength(1);
    second.props["build-trigger"] = "afterPrevious";
    expect(buildSteps(slide)).toHaveLength(2);
  } finally {
    f.destroy();
  }
});

test("group/ungroup and resize keep scene positions, connectors and shared fragments", () => {
  const f = fixture();
  try {
    const fragment = f.deck.textFragment(f.slide.id, f.text.id);
    const before = f.deck.read(f.slide.id).slide;
    const textBefore = scenePoint(
      before,
      before.elements.find(
        (e) => e.id === f.text.id
      ) as import("@repo/live-deck").ElementData
    );
    let groupId = "";
    f.commands.run((deck) => {
      groupId = groupSelection(deck, f.slide.id, [f.text.id, f.table.id]);
    });
    const grouped = f.deck.read(f.slide.id).slide;
    expect(
      scenePoint(
        grouped,
        grouped.elements.find(
          (e) => e.id === f.text.id
        ) as import("@repo/live-deck").ElementData
      )
    ).toEqual(textBefore);
    f.commands.gesture("start");
    f.commands.run((deck) =>
      deck.updateElements(
        f.slide.id,
        transformPatches(
          deck.read(f.slide.id).slide,
          groupId,
          { h: "320", w: "640" },
          [groupId]
        )
      )
    );
    f.commands.run((deck) =>
      deck.setElementKey(f.slide.id, groupId, "props", "x", "100")
    );
    f.commands.gesture("end");
    f.commands.undo.undo();
    expect(
      f.deck.read(f.slide.id).slide.elements.find((e) => e.id === groupId)
        ?.props.w
    ).toBe("320");
    f.commands.run((deck) => ungroupSelection(deck, f.slide.id, groupId));
    const after = f.deck.read(f.slide.id).slide;
    expect(
      scenePoint(
        after,
        after.elements.find(
          (e) => e.id === f.text.id
        ) as import("@repo/live-deck").ElementData
      )
    ).toEqual(textBefore);
    expect(f.deck.textFragment(f.slide.id, f.text.id)).toBe(fragment);
    f.deck.validate();
  } finally {
    f.destroy();
  }
});
test("simultaneous slide moves and independent theme/layout keys converge without duplicate slides", () => {
  const f = fixture();
  try {
    const second = emptySlide(f.deck);
    f.deck.addSlide(second);
    const third = emptySlide(f.deck);
    f.deck.addSlide(third);
    f.remote.applyUpdate(encodeStateAsUpdate(f.deck.doc));
    f.commands.run((deck) => {
      deck.moveSlide(f.slide.id, second.id, third.id);
      deck.setTheme({ colors: { primary: "#ef4444" }, fonts: {}, sizes: {} });
      deck.updateSlide(second.id, {
        layout: { ...second.layout, gap: "20px" },
      });
    });
    f.remote.moveSlide(f.slide.id, third.id, null);
    f.remote.setTheme({ colors: {}, fonts: {}, sizes: { body: "32px" } });
    f.remote.updateSlide(second.id, {
      layout: { ...second.layout, padding: "40px" },
    });
    f.deck.applyUpdate(encodeStateAsUpdate(f.remote.doc));
    f.remote.applyUpdate(encodeStateAsUpdate(f.deck.doc));
    expect(f.deck.ids()).toEqual(f.remote.ids());
    expect(new Set(f.deck.ids()).size).toBe(3);
    expect(f.deck.theme()).toEqual({
      colors: { primary: "#ef4444" },
      fonts: {},
      sizes: { body: "32px" },
    });
    expect(f.deck.read(second.id).slide.layout).toMatchObject({
      gap: "20px",
      padding: "40px",
    });
    f.ports.provider.state = "rejected";
    expect(() => f.commands.run((deck) => deck.deleteSlide(second.id))).toThrow(
      "synchronized"
    );
  } finally {
    f.destroy();
  }
});
test("entrance and exit are separate events and withPrevious batches entrances before exits", () => {
  const f = fixture();
  try {
    const { slide } = f.deck.read(f.slide.id);
    const [a, b] = slide.elements;
    if (!(a && b)) {
      throw new Error("fixture missing");
    }
    a.props = {
      ...a.props,
      "build-in": "fade",
      "build-order": "1",
      "build-out": "left",
      "build-trigger": "click",
    };
    b.props = {
      ...b.props,
      "build-in": "rise",
      "build-order": "1",
      "build-trigger": "withPrevious",
    };
    const steps = buildSteps(slide);
    expect(steps).toHaveLength(2);
    expect(steps[0]?.map((event) => event.phase)).toEqual(["in", "in"]);
    expect(steps[1]?.[0]?.phase).toBe("out");
  } finally {
    f.destroy();
  }
});

test("deck rich text list, split, cell formatting and undo/redo remain inside the strict scene grammar", () => {
  const f = fixture();
  const text = new Editor({
    extensions: deckTextExtensions(f.deck.textFragment(f.slide.id, f.text.id)),
  });
  const cell = new Editor({
    extensions: deckTextExtensions(
      f.deck.cellFragment(f.slide.id, f.table.id, "0:0")
    ),
  });
  try {
    text.commands.toggleBulletList();
    text.commands.insertContentAt(1, "List item");
    text.commands.splitListItem("listItem");
    cell.commands.insertContentAt(1, "Cell content");
    cell.commands.toggleBold();
    cell.commands.toggleBulletList();
    f.deck.validate();
    f.remote.applyUpdate(encodeStateAsUpdate(f.deck.doc));
    expect(f.remote.read(f.slide.id).slide).toEqual(
      f.deck.read(f.slide.id).slide
    );
    cell.commands.undo();
    f.deck.validate();
    cell.commands.redo();
    f.deck.validate();
    f.remote.applyUpdate(encodeStateAsUpdate(f.deck.doc));
    expect(f.remote.read(f.slide.id).slide).toEqual(
      f.deck.read(f.slide.id).slide
    );
  } finally {
    text.destroy();
    cell.destroy();
    f.destroy();
  }
});

test("two mounted cell bindings preserve the peer's text through local undo and redo", () => {
  const f = fixture();
  const localCell = f.deck.cellFragment(f.slide.id, f.table.id, "0:0");
  const remoteCell = f.remote.cellFragment(f.slide.id, f.table.id, "0:0");
  expect(localCell._item?.id).toEqual(remoteCell._item?.id);
  const a = new Editor({
    extensions: deckTextExtensions(
      f.deck.cellFragment(f.slide.id, f.table.id, "0:0")
    ),
  });
  const b = new Editor({
    extensions: deckTextExtensions(
      f.remote.cellFragment(f.slide.id, f.table.id, "0:0")
    ),
  });
  try {
    a.commands.insertContentAt(1, "Cell Alice");
    b.commands.insertContentAt(1, "Cell Bob");
    f.deck.applyUpdate(encodeStateAsUpdate(f.remote.doc));
    f.remote.applyUpdate(encodeStateAsUpdate(f.deck.doc));
    expect(a.getText()).toContain("Cell Bob");
    expect(b.getText()).toContain("Cell Alice");
    a.commands.undo();
    f.remote.applyUpdate(encodeStateAsUpdate(f.deck.doc));
    expect(a.getText()).toBe("Cell Bob");
    expect(b.getText()).toBe("Cell Bob");
    a.commands.redo();
    f.remote.applyUpdate(encodeStateAsUpdate(f.deck.doc));
    expect(b.getText()).toContain("Cell Alice");
    expect(b.getText()).toContain("Cell Bob");
  } finally {
    a.destroy();
    b.destroy();
    f.destroy();
  }
});
