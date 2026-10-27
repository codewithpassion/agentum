/** Local component acceptance fixture. Never imported by the application. */
import { createExtensions, sanitizeJSON, schema } from "@repo/live-doc/schema";
import { Editor } from "@tiptap/core";
import { Collaboration } from "@tiptap/extension-collaboration";
import { yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import { createRoot } from "react-dom/client";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";
import { applyUpdate, Doc, encodeStateAsUpdate } from "yjs";
import { DocumentEditor } from "../document-editor";
import { relativeAt } from "../editor-binding";
import type {
  DocumentEditorPorts,
  EditorRole,
  EditorSelection,
  TrustedParticipant,
} from "../editor-ports";
import "../../../styles.css";

const ownBlobUrls = new Set<string>();
const docs = [new Doc(), new Doc(), new Doc()] as const;
const control = new Editor({
  extensions: [
    ...createExtensions({ ownBlobUrls }),
    Collaboration.configure({ fragment: docs[2].getXmlFragment("content") }),
  ],
});
const seed = sanitizeJSON({
  content: [
    {
      content: [{ text: "Collaborative document", type: "text" }],
      type: "paragraph",
    },
    { attrs: { intent: "Preparing the next section" }, type: "pending" },
  ],
  type: "doc",
});
control.commands.setContent(seed);
for (const doc of docs.slice(0, 2)) {
  applyUpdate(doc, encodeStateAsUpdate(docs[2]));
}
for (const source of docs) {
  source.on("update", (update, origin) => {
    if (origin !== "fixture") {
      for (const target of docs) {
        if (source !== target) {
          applyUpdate(target, update, "fixture");
        }
      }
    }
  });
}
const awareness = docs.map((doc) => new Awareness(doc));
const roster: readonly TrustedParticipant[] = [
  {
    clientId: docs[0].clientID,
    color: "#3b82f6",
    id: "alice",
    kind: "member",
    name: "Alice",
  },
  {
    clientId: docs[1].clientID,
    color: "#10b981",
    id: "bob",
    kind: "guest",
    name: "Bob",
  },
  {
    clientId: docs[2].clientID,
    color: "#8b5cf6",
    id: "agent",
    kind: "agent",
    name: "Research agent",
    status: { text: "Rewriting the introduction", updatedAt: Date.now() },
  },
];
for (const source of awareness) {
  source.on(
    "update",
    (
      {
        added,
        updated,
        removed,
      }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown
    ) => {
      if (origin !== "fixture") {
        for (const target of awareness) {
          if (source !== target) {
            applyAwarenessUpdate(
              target,
              encodeAwarenessUpdate(source, [...added, ...updated, ...removed]),
              "fixture"
            );
          }
        }
      }
    }
  );
}
awareness[2]?.setLocalState({
  cursor: { anchor: relativeAt(control, 1), head: relativeAt(control, 6) },
});
const events: {
  ask?: EditorSelection;
  comment?: EditorSelection;
  restored?: string;
} = {};
const ports = (index: 0 | 1): DocumentEditorPorts => ({
  document: docs[index],
  history: {
    downloadMarkdown: () =>
      Promise.resolve({
        filename: "document.md",
        markdown:
          "Collaborative document\n\n[Pending: Preparing the next section]",
      }),
    list: () =>
      Promise.resolve([
        {
          createdAt: "2026-10-27T00:00:00Z",
          id: "checkpoint-1",
          label: "Original",
        },
      ]),
    restore: (id) => {
      if (id !== "checkpoint-1") {
        return Promise.reject(new Error("Unknown checkpoint"));
      }
      control.commands.setContent(seed);
      events.restored = id;
      return Promise.resolve();
    },
  },
  onAskAgent: (selection) => {
    events.ask = selection;
  },
  onCommentSelection: (selection) => {
    events.comment = selection;
  },
  policy: { ownBlobUrls },
  provider: {
    awareness: awareness[index] as Awareness,
    getSnapshot: () => roster,
    subscribe: () => () => undefined,
    synced: true,
  },
  role: "editor",
  sidebar: <p>Injected sidebar slot</p>,
  uploadImage: async (file) => {
    const result = await fetch("/fixture/upload", {
      body: file,
      method: "POST",
    });
    if (!result.ok) {
      throw new Error("Fixture upload failed");
    }
    const uploaded = (await result.json()) as { url: string; alt: string };
    ownBlobUrls.add(uploaded.url);
    return uploaded;
  },
});
const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing fixture mount");
}
const reactRoot = createRoot(root);
const alicePorts = ports(0),
  bobPorts = ports(1);
function render(role: EditorRole = "editor") {
  reactRoot.render(
    <main>
      <div data-replica="alice">
        <DocumentEditor {...alicePorts} role={role} />
      </div>
      <div data-replica="bob">
        <DocumentEditor {...bobPorts} />
      </div>
    </main>
  );
}
render();
const fixture = {
  events,
  json: (index: 0 | 1) =>
    yXmlFragmentToProseMirrorRootNode(
      docs[index].getXmlFragment("content"),
      schema
    ).toJSON(),
  reset: () => control.commands.setContent(seed),
  setRole: render,
};
Object.assign(window, { editorFixture: fixture });
