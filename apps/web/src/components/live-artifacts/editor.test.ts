import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { sanitizeJSON } from "@repo/live-doc/schema";
import type { Editor } from "@tiptap/core";
import { yCursorPluginKey } from "@tiptap/y-tiptap";
import { Window } from "happy-dom";
import { Awareness } from "y-protocols/awareness";
import { applyUpdate, Doc, encodeStateAsUpdate } from "yjs";
import {
  applyBlock,
  blockActions,
  changeCase,
  moveBlock,
  setEditorLink,
  setThemeColor,
} from "./editor-actions";
import {
  agentDecorationsKey,
  createDocumentEditor,
  relativeAt,
  resolveRelative,
  selectedContext,
  trustedAwareness,
  uploadEditorImage,
} from "./editor-binding";
import { EditorImagePolicy } from "./editor-image-policy";
import type { DocumentEditorPorts } from "./editor-ports";

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
const instances: { editor: Editor; ports: DocumentEditorPorts }[] = [];
afterEach(() => {
  for (const { editor, ports } of instances.splice(0)) {
    editor.destroy();
    ports.provider.awareness.destroy();
    ports.document.destroy();
  }
});
function setup(
  doc = new Doc(),
  role: DocumentEditorPorts["role"] = "editor",
  awarenessId = doc.clientID
) {
  const awareness = new Awareness(doc);
  awareness.setLocalState(null);
  awareness.clientID = awarenessId;
  const roster = [
    {
      clientId: awarenessId,
      color: "#3b82f6",
      id: "me",
      kind: "member" as const,
      name: "Alice",
    },
  ];
  const allowed = new Set<string>();
  const ports: DocumentEditorPorts = {
    document: doc,
    history: {
      downloadMarkdown: async () => ({
        filename: "document.md",
        markdown: "checkpoint",
      }),
      list: async () => [],
      restore: () => {
        throw new Error("Not used in editor engine tests");
      },
    },
    onAskAgent: () => {
      throw new Error("Not used in editor engine tests");
    },
    onCommentSelection: () => {
      throw new Error("Not used in editor engine tests");
    },
    policy: { ownBlobUrls: allowed },
    provider: {
      awareness,
      getSnapshot: () => roster,
      subscribe: () => () => undefined,
      synced: true,
    },
    role,
    uploadImage: async () => ({ alt: "Uploaded", url: "/files/owned.png" }),
  };
  const element = window.document.createElement("div");
  window.document.body.append(element);
  const editor = createDocumentEditor(ports, element as unknown as HTMLElement);
  instances.push({ editor, ports });
  return { allowed, editor, ports, roster };
}
function text(editor: Editor, value = "hello WORLD") {
  editor.commands.insertContent({
    content: [{ text: value, type: "text" }],
    type: "paragraph",
  });
  editor.commands.setTextSelection({ from: 1, to: value.length + 1 });
}

test("actual editors share all marks and preserve remote content on own undo and redo", () => {
  const a = setup();
  text(a.editor, "hello");
  const bdoc = new Doc();
  applyUpdate(bdoc, encodeStateAsUpdate(a.ports.document));
  const b = setup(bdoc);
  const wireA = (update: Uint8Array, origin: unknown) => {
    if (origin !== "wire") {
      applyUpdate(bdoc, update, "wire");
    }
  };
  const wireB = (update: Uint8Array, origin: unknown) => {
    if (origin !== "wire") {
      applyUpdate(a.ports.document, update, "wire");
    }
  };
  a.ports.document.on("update", wireA);
  bdoc.on("update", wireB);
  for (const mark of ["bold", "italic", "underline", "strike", "code"]) {
    a.editor.commands.setTextSelection({ from: 1, to: 6 });
    expect(a.editor.commands.toggleMark(mark)).toBe(true);
    expect(b.editor.getJSON()).toEqual(a.editor.getJSON());
  }
  b.editor.commands.insertContentAt(6, " remote");
  a.editor.commands.insertContentAt(1, "mine ");
  expect(a.editor.commands.undo()).toBe(true);
  expect(a.editor.getText()).toBe("hello remote");
  expect(a.editor.commands.redo()).toBe(true);
  expect(b.editor.getText()).toBe("mine hello remote");
});

test("case commands keep marks, chips, Unicode and unselected text", () => {
  const { editor } = setup();
  editor.commands.insertContent({
    content: [
      { marks: [{ type: "bold" }], text: "hEL", type: "text" },
      { text: "Lo wORLD", type: "text" },
      { attrs: { label: "@Alice", value: "me" }, type: "mention" },
      { text: " suffix", type: "text" },
    ],
    type: "paragraph",
  });
  editor.commands.setTextSelection({ from: 1, to: 12 });
  expect(changeCase(editor, "title")).toBe(true);
  expect(editor.state.doc.textContent).toBe("Hello World suffix");
  expect(editor.state.doc.firstChild?.firstChild?.marks[0]?.type.name).toBe(
    "bold"
  );
  expect(
    editor
      .getJSON()
      .content?.[0]?.content?.some((node) => node.type === "mention")
  ).toBe(true);
  editor.commands.setTextSelection({ from: 1, to: 12 });
  changeCase(editor, "upper");
  expect(editor.getText()).toContain("HELLO WORLD");
  editor.commands.setTextSelection({ from: 1, to: 12 });
  changeCase(editor, "lower");
  expect(editor.getText()).toContain("hello world");
  editor.commands.setTextSelection({ from: 1, to: 12 });
  changeCase(editor, "sentence");
  expect(editor.getText()).toContain("Hello world");
});

for (const action of blockActions) {
  test(`actual block command: ${action}`, () => {
    const { editor } = setup();
    text(editor);
    expect(applyBlock(editor, action)).toBe(true);
    expect(editor.getJSON().content?.length).toBeGreaterThan(0);
    if (action.startsWith("Heading")) {
      expect(
        editor.isActive("heading", { level: Number(action.slice(-1)) })
      ).toBe(true);
    }
    if (action === "Checklist") {
      expect(editor.isActive("taskList")).toBe(true);
    }
  });
}

test("tables support rows, columns, header and fixed cell colors", () => {
  const { editor } = setup();
  expect(applyBlock(editor, "Table")).toBe(true);
  expect(editor.commands.addRowAfter()).toBe(true);
  expect(editor.commands.addColumnAfter()).toBe(true);
  expect(editor.commands.toggleHeaderRow()).toBe(true);
  expect(setThemeColor(editor, "#ef4444", true)).toBe(true);
  expect(JSON.stringify(editor.getJSON())).toContain("#ef4444");
  expect(editor.commands.deleteRow()).toBe(true);
  expect(editor.commands.deleteColumn()).toBe(true);
  expect(setThemeColor(editor, "url(evil)", true)).toBe(false);
});

test("safe links, colors and clear formatting use real commands", () => {
  const { editor } = setup();
  text(editor);
  expect(setEditorLink(editor, "javascript:alert(1)")).toBe(false);
  expect(setEditorLink(editor, "https://example.com")).toBe(true);
  expect(setThemeColor(editor, "#ef4444")).toBe(true);
  expect(editor.isActive("link")).toBe(true);
  editor.chain().unsetAllMarks().clearNodes().run();
  expect(editor.isActive("link")).toBe(false);
});

test("upload waits for persistence, rejects hotlinks and inserts at the relative location", async () => {
  const { editor, ports, allowed } = setup();
  text(editor, "hello");
  editor.commands.setTextSelection(3);
  let finish: (value: { url: string; alt: string }) => void = () => {
    throw new Error("Upload not started");
  };
  ports.uploadImage = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const result = uploadEditorImage(
    editor,
    new File(["png"], "photo.png", { type: "image/png" }),
    ports,
    allowed
  );
  editor.commands.insertContentAt(1, "NEW");
  finish({ alt: "Owned image", url: "/files/owned.png" });
  await result;
  expect(allowed.has("/files/owned.png")).toBe(true);
  expect(JSON.stringify(editor.getJSON())).toContain("Owned image");
  expect(editor.state.doc.child(0).textContent).toBe("NEWhe");
  expect(editor.state.doc.child(2).textContent).toBe("llo");
  ports.uploadImage = async () => ({
    alt: "bad",
    url: "https://evil/image.png",
  });
  await expect(
    uploadEditorImage(
      editor,
      new File(["png"], "photo.png", { type: "image/png" }),
      ports,
      allowed
    )
  ).rejects.toThrow("invalid owned image");
});

test("relative selection survives another edit; move keeps IDs and untouched blocks", () => {
  const { editor } = setup();
  text(editor, "hello");
  const selection = selectedContext(editor);
  expect(selection?.text).toBe("hello");
  editor.commands.insertContentAt(1, "X");
  expect(selection && resolveRelative(editor, selection.end)).toBe(7);
  editor.commands.insertContentAt(editor.state.doc.content.size, {
    content: [{ text: "second", type: "text" }],
    type: "paragraph",
  });
  const first = editor.state.doc.child(0).attrs.id,
    second = editor.state.doc.child(1).attrs.id;
  expect(moveBlock(editor, second, first)).toBe(true);
  expect(editor.state.doc.child(0).attrs.id).toBe(second);
  expect(editor.getText()).toBe("second\n\nXhello");
});

for (const role of ["viewer", "commenter"] as const) {
  test(`${role} rejects programmatic content mutations and uploads`, async () => {
    const { editor, ports, allowed } = setup(undefined, role);
    const before = editor.getJSON();
    editor.commands.insertContent("forbidden");
    expect(editor.getJSON()).toEqual(before);
    expect(applyBlock(editor, "Table")).toBe(false);
    await expect(
      uploadEditorImage(
        editor,
        new File(["x"], "x.png", { type: "image/png" }),
        ports,
        allowed
      )
    ).rejects.toThrow("not permitted");
  });
}

test("awareness identities are projected from trusted roster and unknown peers disappear", () => {
  const { ports } = setup();
  ports.provider.awareness.setLocalState({
    cursor: { head: {} },
    user: { color: "red", kind: "agent", name: "FORGED" },
  });
  ports.provider.awareness.states.set(42, { user: { name: "Intruder" } });
  const trusted = trustedAwareness(ports.provider).getStates();
  expect(trusted.get(ports.document.clientID)?.user.name).toBe("Alice");
  expect(trusted.has(42)).toBe(false);
});

test("role downgrade also disables Yjs undo/redo, while remote edits remain visible", () => {
  const a = setup();
  text(a.editor, "own");
  a.editor.setEditable(false);
  expect(a.editor.commands.undo()).toBe(false);
  expect(a.editor.commands.redo()).toBe(false);
  expect(a.editor.getText()).toBe("own");
  const doc = new Doc();
  applyUpdate(doc, encodeStateAsUpdate(a.ports.document));
  const b = setup(doc);
  b.editor.commands.insertContentAt(4, " remote");
  applyUpdate(a.ports.document, encodeStateAsUpdate(doc), "wire");
  expect(a.editor.getText()).toBe("own remote");
});

test("all content action groups converge in a second actual editor", async () => {
  const a = setup();
  text(a.editor, "hello world");
  const doc = new Doc();
  applyUpdate(doc, encodeStateAsUpdate(a.ports.document));
  const b = setup(doc);
  const sync = () => {
    applyUpdate(doc, encodeStateAsUpdate(a.ports.document), "wire");
    expect(b.editor.getJSON()).toEqual(a.editor.getJSON());
  };
  for (const mode of ["upper", "lower", "title", "sentence"] as const) {
    a.editor.commands.setTextSelection({ from: 1, to: 12 });
    expect(changeCase(a.editor, mode)).toBe(true);
    sync();
  }
  expect(setEditorLink(a.editor, "/help")).toBe(true);
  sync();
  expect(setThemeColor(a.editor, "#8b5cf6")).toBe(true);
  sync();
  a.editor.chain().unsetAllMarks().clearNodes().run();
  sync();
  for (const action of blockActions) {
    a.editor.commands.selectAll();
    a.editor.commands.deleteSelection();
    a.editor.commands.insertContent("hello");
    expect(applyBlock(a.editor, action)).toBe(true);
    sync();
  }
  for (const command of [
    "addRowBefore",
    "addRowAfter",
    "addColumnBefore",
    "addColumnAfter",
    "toggleHeaderRow",
    "deleteRow",
    "deleteColumn",
  ] as const) {
    expect(a.editor.commands[command]()).toBe(true);
    sync();
  }
  expect(setThemeColor(a.editor, "#10b981", true)).toBe(true);
  sync();
  a.editor.commands.insertContentAt(a.editor.state.doc.content.size, {
    content: [
      { attrs: { label: "@Alice", value: "alice" }, type: "mention" },
      { attrs: { label: "27 Oct", value: "2026-10-27" }, type: "date" },
    ],
    type: "paragraph",
  });
  sync();
  const image = new File(["png"], "photo.png", { type: "image/png" });
  b.allowed.add("/files/owned.png");
  await uploadEditorImage(a.editor, image, a.ports, a.allowed);
  sync();
  const first = a.editor.state.doc.child(0).attrs.id;
  const last = a.editor.state.doc.lastChild?.attrs.id;
  expect(moveBlock(a.editor, last, first)).toBe(true);
  sync();
});

test("agent decorations follow relative positions and are separate from content", () => {
  const { editor } = setup();
  text(editor, "hello");
  const selection = selectedContext(editor);
  if (!selection) {
    throw new Error("Missing selection");
  }
  editor.view.dispatch(
    editor.state.tr.setMeta(agentDecorationsKey, [
      { ...selection, id: "change-1", name: "Research agent" },
    ])
  );
  expect(editor.view.dom.querySelector(".live-agent-change")?.textContent).toBe(
    "hello"
  );
  editor.commands.insertContentAt(1, "NEW ");
  expect(editor.view.dom.querySelector(".live-agent-change")?.textContent).toBe(
    "hello"
  );
  expect(JSON.stringify(editor.getJSON())).not.toContain("live-agent-change");
  editor.view.dispatch(editor.state.tr.setMeta(agentDecorationsKey, []));
  expect(editor.view.dom.querySelector(".live-agent-change")).toBeNull();
});

test("initial content is checked against the injected own-image policy", () => {
  const a = setup();
  a.allowed.add("/files/owned.png");
  a.editor.commands.insertContent({
    attrs: { alt: "Owned", src: "/files/owned.png" },
    type: "image",
  });
  const doc = new Doc();
  applyUpdate(doc, encodeStateAsUpdate(a.ports.document));
  const awareness = new Awareness(doc);
  try {
    expect(() =>
      createDocumentEditor({
        ...a.ports,
        document: doc,
        policy: {},
        provider: { ...a.ports.provider, awareness },
      })
    ).toThrow("Initial room content");
  } finally {
    awareness.destroy();
    doc.destroy();
  }
});

test("two disconnected editors merge concurrent typing and each undo keeps the other person's text", () => {
  const a = setup();
  text(a.editor, "hello");
  const doc = new Doc();
  applyUpdate(doc, encodeStateAsUpdate(a.ports.document));
  const b = setup(doc);
  a.editor.commands.insertContentAt(1, "Alice ");
  b.editor.commands.insertContentAt(6, " Bob");
  const updateA = encodeStateAsUpdate(a.ports.document),
    updateB = encodeStateAsUpdate(doc);
  applyUpdate(a.ports.document, updateB, "wire");
  applyUpdate(doc, updateA, "wire");
  expect(a.editor.getText()).toBe("Alice hello Bob");
  expect(b.editor.getJSON()).toEqual(a.editor.getJSON());
  expect(a.editor.commands.undo()).toBe(true);
  applyUpdate(doc, encodeStateAsUpdate(a.ports.document), "wire");
  expect(b.editor.getText()).toBe("hello Bob");
  expect(b.editor.commands.undo()).toBe(true);
  applyUpdate(a.ports.document, encodeStateAsUpdate(doc), "wire");
  expect(a.editor.getText()).toBe("hello");
});

test("stale agent cursors clear locally even if the final awareness packet is lost", () => {
  const { editor, ports } = setup();
  text(editor, "hello");
  const selection = selectedContext(editor);
  if (!selection) {
    throw new Error("Missing selection");
  }
  ports.provider.awareness.states.set(42, {
    cursor: { anchor: selection.start, head: selection.end },
    user: { name: "forged" },
  });
  ports.provider.getSnapshot = () => [
    {
      clientId: 42,
      color: "#8b5cf6",
      id: "agent",
      kind: "agent",
      name: "Trusted agent",
      status: { text: "Working", updatedAt: Date.now() - 6000 },
    },
  ];
  expect(
    trustedAwareness(ports.provider).getStates().get(42)?.cursor
  ).toBeNull();
});

test("case changes handle Unicode expansion while preserving formatting and own undo", () => {
  const { editor } = setup();
  text(editor, "straße café");
  editor.commands.setBold();
  expect(changeCase(editor, "upper")).toBe(true);
  expect(editor.getText()).toBe("STRASSE CAFÉ");
  expect(editor.state.doc.firstChild?.firstChild?.marks[0]?.type.name).toBe(
    "bold"
  );
  editor.commands.undo();
  expect(editor.getText()).toBe("straße café");
});

test("authoritative image policy removes stale URLs and reconciles local uploads", () => {
  const policy = new EditorImagePolicy();
  const image = {
    content: [{ attrs: { src: "/files/a.png" }, type: "image" }],
    type: "doc",
  };
  policy.update(["/files/a.png"]);
  expect(JSON.stringify(sanitizeJSON(image, policy))).toContain("/files/a.png");
  policy.update([]);
  expect(JSON.stringify(sanitizeJSON(image, policy))).not.toContain(
    "/files/a.png"
  );
  policy.uploads.add("/files/a.png");
  policy.update([]);
  expect(JSON.stringify(sanitizeJSON(image, policy))).toContain("/files/a.png");
  policy.update(["/files/a.png"]);
  policy.update([]);
  expect(JSON.stringify(sanitizeJSON(image, policy))).not.toContain(
    "/files/a.png"
  );
});

test("caret filtering uses assigned awareness ID and preserves a remote ID equal to the document ID", () => {
  const replica = setup(undefined, "owner", 101);
  text(replica.editor, "hello");
  const cursor = {
    anchor: relativeAt(replica.editor, 1),
    head: relativeAt(replica.editor, 2),
  };
  replica.ports.provider.awareness.setLocalState({ cursor });
  const documentId = replica.ports.document.clientID;
  expect(documentId).not.toBe(101);
  replica.roster.push({
    clientId: documentId,
    color: "#123456",
    id: "remote",
    kind: "member",
    name: "Bob",
  });
  replica.ports.provider.awareness.states.set(documentId, {
    cursor,
    user: { name: "FORGED" },
  });
  replica.editor.view.dispatch(
    replica.editor.state.tr.setMeta(yCursorPluginKey, {
      awarenessUpdated: true,
    })
  );
  expect(replica.editor.view.dom.textContent).toContain("Bob");
  expect(replica.editor.view.dom.textContent).not.toContain("Alice");
  expect(replica.editor.view.dom.textContent).not.toContain("FORGED");
  expect(replica.ports.document.clientID).toBe(documentId);
  expect(replica.ports.provider.awareness.clientID).toBe(101);
});
