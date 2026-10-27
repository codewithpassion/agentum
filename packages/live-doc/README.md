# @repo/live-doc

Shared Tiptap schema, DOM-free markdown and guarded rich Yjs document operations. Runtime code uses web APIs only; Bun and Node are used by tests/builds. Storage is the `content` Y.XmlFragment, compatible with Tiptap Collaboration's `field: "content"`. Do not replace it with Y.Text or a JSON blob.

Import document APIs from `@repo/live-doc` and schema APIs from `@repo/live-doc/schema`. The integration contract, errors, assumptions and validation evidence are in [L.2 review](../../docs/reviews/tasks/L.2.md).

```ts
import { LiveDocument } from "@repo/live-doc";
import { createExtensions, sanitizeJSON } from "@repo/live-doc/schema";
import { Doc } from "yjs";

const policy = { ownBlobUrls: new Set(["/files/verified-owned-image.png"]) };
const room = new LiveDocument(new Doc(), policy);
room.import({ markdown: "# Brief\n\nFirst draft." }, "create");
const block = room.read().blocks.find(b => b.type === "paragraph")!;
const origin = {
  changeId: "change-1", participantId: "agent-1", runId: "run-1",
  toolCallId: "call-1", mode: "direct" as const,
};
const { change } = room.capture([{
  op: "replace", target: { blockId: block.id },
  ifHash: block.hash, ifRev: block.revision,
  content: { markdown: "Revised **draft**." },
}], origin);
// Persist `change` with agent attribution. After later human edits or a restart:
room.revert(change, { participantId: "member-1" });

// Browser: sanitize initial content before creating an Editor. The extension
// list installs the transaction gate. Add Collaboration configured for content;
// do not enable a second ProseMirror history implementation.
const editorOptions = {
  extensions: createExtensions(policy),
  content: sanitizeJSON(room.json(), policy),
};
```

Use `room.applyUpdate(bytes, authenticatedOrigin)` for socket/editor updates. It validates a disposable replica before changing authoritative state. Use `import` for creation/JSON/markdown import and `restoreSnapshot` for checkpoint restore. Never apply untrusted updates directly to the authoritative Y.Doc and then try to sanitize them: Yjs transactions cannot roll back. Room authentication, read-only enforcement, persistence, quotas and image ownership verification belong to the callers.

`bun run test` in this package covers operations, concurrent rich replicas, origin undo, restart-safe selective revert, hostile JSON/markdown/Yjs/editor transactions and DOM rendering. A Bun-built browser bundle is exercised in actual workerd through a Node-hosted Miniflare runner; Node hosting avoids Bun/Miniflare transport incompatibility. `bun run build` produces browser-compatible ES modules under ignored `dist/`.
