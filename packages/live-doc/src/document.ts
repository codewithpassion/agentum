import type {
  LiveOperationOrigin,
  RelativePositionJSON,
} from "@repo/protocol/live";
import type { JSONContent } from "@tiptap/core";
import {
  initProseMirrorDoc,
  updateYFragment,
  yXmlFragmentToProseMirrorRootNode,
} from "@tiptap/y-tiptap";
import {
  type AbsolutePosition,
  applyUpdate,
  createAbsolutePositionFromRelativePosition,
  createRelativePositionFromJSON,
  createRelativePositionFromTypeIndex,
  Doc,
  encodeStateAsUpdate,
  relativePositionToJSON,
  type Transaction,
  UndoManager,
  XmlElement,
  type XmlFragment,
  XmlText,
} from "yjs";
import {
  BLOCK_TYPES,
  type ContentPolicy,
  fromMarkdown,
  sanitizeJSON,
  schema,
  toMarkdown,
} from "./schema";

export interface Block {
  content: JSONContent;
  hash: string;
  id: string;
  parentId?: string;
  revision: number;
  text: string;
  type: string;
}
export interface Outline {
  blocks: Block[];
  deleted: string[];
  revision: number;
}
export type Target =
  | { blockId: string }
  | { find: string; nth?: number; blockId?: string };
export interface Guard {
  ifHash: string;
  ifRev: number;
}
export type Content =
  | { markdown: string }
  | { text: string }
  | { json: JSONContent };
export type Operation =
  | {
      op: "replace" | "delete";
      target: Target;
      ifHash?: string;
      ifRev?: number;
      content?: Content;
    }
  | {
      op: "insert";
      content: Content;
      before?: string;
      after?: string;
      at?: RelativePositionJSON;
    }
  | {
      op: "move";
      blockId: string;
      before?: string;
      after?: string;
      ifHash: string;
      ifRev: number;
    }
  | {
      op: "set";
      blockId: string;
      type?:
        | "paragraph"
        | "heading"
        | "bulletList"
        | "orderedList"
        | "taskList";
      attrs: Record<string, unknown>;
      ifHash: string;
      ifRev: number;
    }
  | { op: "fill"; blockId: string; content: Content }
  | {
      op: "table";
      blockId: string;
      action: "insertRow" | "deleteRow" | "insertColumn" | "deleteColumn";
      index: number;
      ifHash: string;
      ifRev: number;
    };
export type DocumentErrorCode =
  | "guard_mismatch"
  | "block_gone"
  | "invalid_content"
  | "find_not_found"
  | "ambiguous_find"
  | "invalid_position"
  | "comment_anchor"
  | "revision_gone";
export class DocumentError extends Error {
  readonly code: DocumentErrorCode;
  readonly current?: Block;
  constructor(
    code: DocumentErrorCode,
    current?: Block,
    options?: ErrorOptions
  ) {
    super(code, options);
    this.code = code;
    this.current = current;
  }
}
export function hashBlock(value: unknown): string {
  let hash = 0x81_1c_9d_c5;
  for (const byte of new TextEncoder().encode(
    JSON.stringify(value, (key, item) => (key === "id" ? undefined : item))
  )) {
    // biome-ignore lint/suspicious/noBitwiseOperators: FNV-1a operates on unsigned 32-bit words.
    hash ^= byte;
    hash = Math.imul(hash, 0x01_00_01_93);
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: Convert FNV-1a to an unsigned 32-bit word.
  return (hash >>> 0).toString(16).padStart(8, "0");
}
const textOf = (node: JSONContent): string =>
  node.text ??
  ((node.content ?? []).map(textOf).join("") ||
    String(node.attrs?.label ?? node.attrs?.intent ?? ""));
function elementId(el: XmlElement): string {
  const explicit = el.getAttribute("id");
  if (typeof explicit === "string" && explicit) {
    return explicit;
  }
  const id = el._item?.id;
  if (!id) {
    throw new DocumentError("block_gone");
  }
  return `${id.client.toString(36)}.${id.clock}`;
}
export interface DocumentOptions extends ContentPolicy {
  /** Maximum retained projections, not a substitute for checkpoint history. */
  historyLimit?: number;
  /** Live protected comment ranges. Whole-block deletion/replacement over these is refused. */
  protectedRanges?: () => Array<{
    start: RelativePositionJSON;
    end: RelativePositionJSON;
  }>;
  /** Room-authoritative revision seed; persist alongside checkpoints. */
  revision?: number;
}
/** One controller per room Doc. Browser editors use the shared schema and Yjs binding directly. */
export class LiveDocument {
  readonly fragment: XmlFragment;
  private revision: number;
  private blocks: Block[] = [];
  private readonly history = new Map<number, Outline>();
  private readonly changedAt = new Map<string, number>();
  private readonly deletedAt = new Map<string, number>();
  private readonly afterTransaction: (tx: Transaction) => void;
  readonly doc: Doc;
  readonly options: DocumentOptions;
  constructor(doc: Doc, options: DocumentOptions = {}) {
    this.doc = doc;
    this.options = options;
    this.fragment = doc.getXmlFragment("content");
    this.revision = options.revision ?? 0;
    this.project();
    this.afterTransaction = (tx) => {
      if (
        ![...tx.changedParentTypes.keys()].some(
          (type) => type === (this.fragment as unknown)
        )
      ) {
        return;
      }
      const previous = JSON.stringify(
        (this.history.get(this.revision)?.blocks ?? this.blocks).map((b) => [
          b.id,
          b.hash,
        ])
      );
      const old = this.history.get(this.revision)?.blocks ?? this.blocks;
      this.project();
      if (JSON.stringify(this.blocks.map((b) => [b.id, b.hash])) === previous) {
        return;
      }
      this.revision += 1;
      for (const block of this.blocks) {
        const prior = old.find((b) => b.id === block.id);
        if (
          !prior ||
          prior.hash !== block.hash ||
          old.indexOf(prior) !== this.blocks.indexOf(block)
        ) {
          this.changedAt.set(block.id, this.revision);
        }
        block.revision = this.changedAt.get(block.id) ?? this.revision;
      }
      for (const block of old) {
        if (!this.blocks.some((b) => b.id === block.id)) {
          this.deletedAt.set(block.id, this.revision);
        }
      }
      this.remember();
    };
    doc.on("afterTransaction", this.afterTransaction);
    this.remember();
  }
  destroy() {
    this.doc.off("afterTransaction", this.afterTransaction);
  }
  private project() {
    const json = this.json();
    const blocks: Block[] = [];
    const walk = (
      fragment: XmlFragment | XmlElement,
      nodes: JSONContent[],
      parentId?: string
    ) => {
      let index = 0;
      for (const el of fragment.toArray()) {
        if (!(el instanceof XmlElement)) {
          continue;
        }
        const node = nodes[index];
        index += 1;
        if (!node) {
          continue;
        }
        const id = elementId(el);
        if (BLOCK_TYPES.includes(node.type ?? "")) {
          blocks.push({
            content: node,
            hash: hashBlock(node),
            id,
            parentId,
            revision: this.changedAt.get(id) ?? this.revision,
            text: textOf(node),
            type: node.type ?? "",
          });
        }
        if (node.content?.some((n) => n.type !== "text")) {
          walk(
            el,
            node.content.filter((n) => n.type !== "text"),
            id
          );
        }
      }
    };
    walk(this.fragment, json.content ?? []);
    this.blocks = blocks;
  }
  private remember() {
    this.history.set(
      this.revision,
      structuredClone({
        blocks: this.blocks,
        deleted: [],
        revision: this.revision,
      })
    );
    while (this.history.size > (this.options.historyLimit ?? 100)) {
      const first = this.history.keys().next().value;
      if (first !== undefined) {
        this.history.delete(first);
      }
    }
  }
  json(): JSONContent {
    if (!this.fragment.length) {
      return { content: [], type: "doc" };
    }
    return yXmlFragmentToProseMirrorRootNode(this.fragment, schema).toJSON();
  }
  markdown(): string {
    return toMarkdown(this.json(), this.options);
  }
  read(
    input: { sinceRev?: number; atRev?: number; blockId?: string } = {}
  ): Outline {
    const snapshot =
      input.atRev === undefined
        ? { blocks: this.blocks, deleted: [], revision: this.revision }
        : this.history.get(input.atRev);
    if (
      !snapshot ||
      (input.sinceRev !== undefined &&
        (input.sinceRev > snapshot.revision ||
          input.sinceRev < (this.history.keys().next().value ?? 0)))
    ) {
      throw new DocumentError("revision_gone");
    }
    const blocks = snapshot.blocks.filter(
      (b) =>
        (!input.blockId || b.id === input.blockId) &&
        (input.sinceRev === undefined || b.revision > input.sinceRev)
    );
    return structuredClone({
      blocks,
      deleted:
        input.sinceRev === undefined
          ? []
          : [...this.deletedAt]
              .filter(
                ([, rev]) =>
                  rev > (input.sinceRev ?? snapshot.revision) &&
                  rev <= snapshot.revision
              )
              .map(([id]) => id),
      revision: snapshot.revision,
    });
  }
  private reconcile(json: JSONContent) {
    const clean = sanitizeJSON(json, this.options);
    const meta = this.fragment.length
      ? initProseMirrorDoc(this.fragment, schema).meta
      : { isOMark: new Map(), mapping: new Map() };
    updateYFragment(this.doc, this.fragment, schema.nodeFromJSON(clean), meta);
  }
  /** Validate untrusted binary editor updates on a replica BEFORE touching authoritative state. */
  applyUpdate(update: Uint8Array, origin: unknown) {
    const replica = new Doc();
    try {
      applyUpdate(replica, encodeStateAsUpdate(this.doc));
      applyUpdate(replica, update);
      const raw = yXmlFragmentToProseMirrorRootNode(
        replica.getXmlFragment("content"),
        schema
      );
      raw.check();
      const clean = schema.nodeFromJSON(
        sanitizeJSON(raw.toJSON(), this.options)
      );
      if (!raw.eq(clean)) {
        throw new DocumentError("invalid_content");
      }
    } catch (cause) {
      // biome-ignore lint/style/useErrorCause: DocumentError preserves the cause through its third argument.
      throw new DocumentError("invalid_content", undefined, { cause });
    } finally {
      replica.destroy();
    }
    applyUpdate(this.doc, update, origin);
  }
  /** For artifact_create, validated editor JSON and checkpoint restore. Use within the room's origin transaction. */
  import(content: Content, origin: unknown) {
    const json = this.content(content);
    this.doc.transact(() => this.reconcile(json), origin);
  }
  private content(content: Content): JSONContent {
    if ("markdown" in content) {
      return fromMarkdown(content.markdown, this.options);
    }
    if ("text" in content) {
      return sanitizeJSON(
        {
          content: [
            {
              content: content.text
                ? [{ text: content.text, type: "text" }]
                : [],
              type: "paragraph",
            },
          ],
          type: "doc",
        },
        this.options
      );
    }
    return sanitizeJSON(content.json, this.options);
  }
  private element(id: string): XmlElement {
    const scan = (parent: XmlFragment | XmlElement): XmlElement | undefined => {
      for (const el of parent.toArray()) {
        if (el instanceof XmlElement) {
          if (elementId(el) === id) {
            return el;
          }
          const nested = scan(el);
          if (nested) {
            return nested;
          }
        }
      }
    };
    const el = scan(this.fragment);
    if (!el) {
      throw new DocumentError("block_gone");
    }
    return el;
  }
  private block(id: string): Block {
    const block = this.blocks.find((b) => b.id === id);
    if (!block) {
      throw new DocumentError("block_gone");
    }
    return block;
  }
  private guard(id: string, op: { ifHash?: string; ifRev?: number }) {
    const block = this.block(id);
    if (op.ifHash !== block.hash || op.ifRev !== block.revision) {
      throw new DocumentError("guard_mismatch", block);
    }
  }
  /** Capture on read, then resolve after concurrent updates; never reuse an absolute text offset. */
  position(blockId: string, offset: number, assoc = 0): RelativePositionJSON {
    const el = this.element(blockId);
    const texts = el
      .toArray()
      .filter((n): n is XmlText => n instanceof XmlText);
    let remaining = offset;
    for (const text of texts) {
      if (remaining >= 0 && remaining <= text.length) {
        return relativePositionToJSON(
          createRelativePositionFromTypeIndex(text, remaining, assoc)
        );
      }
      remaining -= text.length;
    }
    throw new DocumentError("invalid_position");
  }
  resolve(position: RelativePositionJSON): AbsolutePosition {
    const absolute = createAbsolutePositionFromRelativePosition(
      createRelativePositionFromJSON(position),
      this.doc
    );
    if (
      !(absolute && absolute.type instanceof XmlText) ||
      absolute.type._item?.deleted
    ) {
      throw new DocumentError("invalid_position");
    }
    let { parent } = absolute.type;
    while (parent && parent !== this.fragment) {
      if (parent._item?.deleted) {
        throw new DocumentError("invalid_position");
      }
      ({ parent } = parent);
    }
    if (parent !== this.fragment) {
      throw new DocumentError("invalid_position");
    }
    return absolute;
  }
  private find(target: Target): { block: Block; start?: number; end?: number } {
    if (!("find" in target)) {
      return { block: this.block(target.blockId) };
    }
    if (!target.find) {
      throw new DocumentError("find_not_found");
    }
    const matches: Array<{ block: Block; start: number; end: number }> = [];
    for (const block of this.blocks.filter(
      (b) =>
        (!target.blockId || b.id === target.blockId) &&
        ["paragraph", "heading", "codeBlock"].includes(b.type)
    )) {
      for (
        let start = block.text.indexOf(target.find);
        start !== -1;
        start = block.text.indexOf(target.find, start + target.find.length)
      ) {
        matches.push({ block, end: start + target.find.length, start });
      }
    }
    if (target.nth === undefined && matches.length > 1) {
      throw new DocumentError("ambiguous_find");
    }
    const match = matches[(target.nth ?? 1) - 1];
    if (!match) {
      throw new DocumentError("find_not_found");
    }
    return match;
  }
  private protect(el: XmlElement, from?: number, to?: number) {
    for (const range of this.options.protectedRanges?.() ?? []) {
      let a: AbsolutePosition;
      let b: AbsolutePosition;
      try {
        a = this.resolve(range.start);
        b = this.resolve(range.end);
      } catch {
        continue;
      }
      let { parent } = a.type;
      while (parent && parent !== el) {
        ({ parent } = parent);
      }
      if (
        parent === el &&
        (from === undefined ||
          (a.type === b.type &&
            from < b.index &&
            to !== undefined &&
            to > a.index))
      ) {
        throw new DocumentError("comment_anchor");
      }
    }
  }
  /** All-or-nothing batch: a disposable replica preflights every op, then one live origin transaction. */
  apply(
    ops: Operation[],
    origin: LiveOperationOrigin | object
  ): { revision: number; changeId?: string } {
    const replica = new Doc();
    applyUpdate(replica, encodeStateAsUpdate(this.doc));
    const trial = new LiveDocument(replica, {
      ...this.options,
      revision: this.revision,
    });
    trial.blocks = structuredClone(this.blocks);
    for (const b of this.blocks) {
      trial.changedAt.set(b.id, b.revision);
    }
    try {
      replica.transact(() => {
        for (const op of ops) {
          trial.execute(op);
          trial.project();
        }
      });
    } finally {
      trial.destroy();
      replica.destroy();
    }
    this.doc.transact(() => {
      for (const op of ops) {
        this.execute(op);
        this.project();
      }
    }, origin);
    return {
      changeId: "changeId" in origin ? String(origin.changeId) : undefined,
      revision: this.revision,
    };
  }
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Exhaustive operation dispatch keeps guard and write order explicit.
  private execute(op: Operation) {
    if (op.op === "insert" && op.at) {
      if (!("text" in op.content)) {
        throw new DocumentError("invalid_content");
      }
      const at = this.resolve(op.at);
      (at.type as XmlText).insert(at.index, op.content.text);
      return;
    }
    if (op.op === "replace" || op.op === "delete") {
      const match = this.find(op.target);
      if (match.start !== undefined && match.end !== undefined) {
        const start = this.resolve(this.position(match.block.id, match.start));
        const end = this.resolve(this.position(match.block.id, match.end));
        if (start.type !== end.type) {
          throw new DocumentError("invalid_position");
        }
        this.protect(this.element(match.block.id), start.index, end.index);
        const text = start.type as XmlText;
        if (op.op === "replace" && !(op.content && "text" in op.content)) {
          throw new DocumentError("invalid_content");
        }
        text.delete(start.index, end.index - start.index);
        if (op.op === "replace" && op.content && "text" in op.content) {
          text.insert(start.index, op.content.text);
        }
        return;
      }
      this.guard(match.block.id, op);
      this.protect(this.element(match.block.id));
    }
    const json = this.json();
    const tag = (parent: XmlFragment | XmlElement, nodes: JSONContent[]) => {
      const elements = parent
        .toArray()
        .filter((n): n is XmlElement => n instanceof XmlElement);
      elements.forEach((el, i) => {
        const node = nodes[i];
        if (!node) {
          return;
        }
        node.attrs = { ...node.attrs, id: elementId(el) };
        tag(
          el,
          (node.content ?? []).filter((n) => n.type !== "text")
        );
      });
    };
    tag(this.fragment, json.content ?? []);
    const locate = (id: string): { nodes: JSONContent[]; index: number } => {
      const scan = (
        nodes: JSONContent[]
      ): { nodes: JSONContent[]; index: number } | undefined => {
        for (let index = 0; index < nodes.length; index += 1) {
          const n = nodes[index];
          if (!n) {
            continue;
          }
          if (n.attrs?.id === id) {
            return { index, nodes };
          }
          const nested = scan(n.content ?? []);
          if (nested) {
            return nested;
          }
        }
      };
      const found = scan(json.content ?? []);
      if (!found) {
        throw new DocumentError("block_gone");
      }
      return found;
    };
    const insertAt = (nodes: JSONContent[]) => {
      if (op.op !== "insert" && op.op !== "move") {
        throw new DocumentError("invalid_content");
      }
      if (op.before && op.after) {
        throw new DocumentError("invalid_position");
      }
      const anchor = op.before ?? op.after;
      const at = anchor
        ? locate(anchor)
        : {
            index: (json.content ?? []).length,
            nodes: json.content ?? [],
          };
      at.nodes.splice(at.index + (op.after ? 1 : 0), 0, ...nodes);
    };
    if (op.op === "insert") {
      insertAt(this.content(op.content).content ?? []);
    } else {
      const id = "target" in op ? this.find(op.target).block.id : op.blockId;
      const at = locate(id);
      const node = at.nodes[at.index];
      if (!node) {
        throw new DocumentError("block_gone");
      }
      if (op.op === "delete") {
        at.nodes.splice(at.index, 1);
      }
      if (op.op === "replace" || op.op === "fill") {
        if (op.op === "fill" && node.type !== "pending") {
          throw new DocumentError("block_gone");
        }
        if (!op.content) {
          throw new DocumentError("invalid_content");
        }
        const replacement = this.content(op.content).content ?? [];
        if (replacement[0]) {
          replacement[0].attrs = { ...replacement[0].attrs, id };
        }
        at.nodes.splice(at.index, 1, ...replacement);
      }
      if (op.op === "set") {
        this.guard(id, op);
        if (op.type) {
          node.type = op.type;
        }
        node.attrs = { ...node.attrs, ...op.attrs, id };
      }
      if (op.op === "move") {
        this.guard(id, op);
        if (op.before === id || op.after === id) {
          throw new DocumentError("invalid_position");
        }
        at.nodes.splice(at.index, 1);
        insertAt([node]);
      }
      if (op.op === "table") {
        this.guard(id, op);
        if (
          node.type !== "table" ||
          !Number.isInteger(op.index) ||
          op.index < 0
        ) {
          throw new DocumentError("invalid_position");
        }
        const rows = node.content ?? [];
        if (
          rows.some((r) =>
            r.content?.some(
              (c) =>
                Number(c.attrs?.colspan ?? 1) !== 1 ||
                Number(c.attrs?.rowspan ?? 1) !== 1
            )
          )
        ) {
          throw new DocumentError("invalid_content");
        }
        const width = rows[0]?.content?.length ?? 0;
        const cell = (): JSONContent => ({
          content: [{ type: "paragraph" }],
          type: "tableCell",
        });
        if (op.action === "insertRow") {
          if (op.index > rows.length) {
            throw new DocumentError("invalid_position");
          }
          rows.splice(op.index, 0, {
            content: Array.from({ length: width }, cell),
            type: "tableRow",
          });
        }
        if (op.action === "deleteRow") {
          if (op.index >= rows.length || rows.length === 1) {
            throw new DocumentError("invalid_position");
          }
          rows.splice(op.index, 1);
        }
        if (op.action === "insertColumn" || op.action === "deleteColumn") {
          if (
            op.index > width ||
            (op.action === "deleteColumn" &&
              (op.index === width || width === 1))
          ) {
            throw new DocumentError("invalid_position");
          }
          for (const row of rows) {
            row.content?.splice(
              op.index,
              op.action === "deleteColumn" ? 1 : 0,
              ...(op.action === "insertColumn" ? [cell()] : [])
            );
          }
        }
      }
    }
    this.reconcile(json);
  }
}
/** Keep one manager per retained agent change, created BEFORE apply, with the exact origin object. */
export function createOriginUndo(doc: Doc, origin: object) {
  return new UndoManager(doc.getXmlFragment("content"), {
    captureTimeout: 0,
    trackedOrigins: new Set([origin]),
  });
}
