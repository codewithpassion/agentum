import type {
  CommentAnchor,
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
  encodeStateVector,
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
  /** Preorder position in the current outline; allows sinceRev consumers to reorder. */
  index: number;
  parentId?: string;
  revision: number;
  text: string;
  type: string;
}
export interface CapturedChange {
  before: Uint8Array;
  changeId: string;
  update: Uint8Array;
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
  | "find_none"
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
  node.type === "hardBreak"
    ? "\n"
    : (node.text ??
      ((node.content ?? []).map(textOf).join("") ||
        String(node.attrs?.label ?? node.attrs?.intent ?? "")));
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
const HASHED_MARK_SUFFIX = /--[a-zA-Z0-9+/=]{8}$/;
function validateTextMarks(text: XmlText): void {
  if (
    text
      .toDelta()
      .some((part: { insert: unknown }) => typeof part.insert !== "string")
  ) {
    throw new DocumentError("invalid_content");
  }
  for (const part of text.toDelta()) {
    for (const [name, attrs] of Object.entries(part.attributes ?? {})) {
      const mark = schema.marks[name.replace(HASHED_MARK_SUFFIX, "")];
      if (
        !(mark && attrs) ||
        typeof attrs !== "object" ||
        Array.isArray(attrs) ||
        Object.keys(attrs).some(
          (key) => !Object.hasOwn(mark.spec.attrs ?? {}, key)
        )
      ) {
        throw new DocumentError("invalid_content");
      }
    }
  }
}
/** Validate raw XML before projection, which deliberately ignores unknown PM attributes. */
function validatedJSON(doc: Doc, policy: ContentPolicy): JSONContent {
  if (doc.store.pendingStructs || doc.store.pendingDs) {
    throw new DocumentError("invalid_content");
  }
  const fragment = doc.getXmlFragment("content");
  const visit = (parent: XmlFragment | XmlElement) => {
    for (const child of parent.toArray()) {
      if (child instanceof XmlElement) {
        const type = schema.nodes[child.nodeName];
        if (
          !type ||
          Object.keys(child.getAttributes()).some(
            (key) => !Object.hasOwn(type.spec.attrs ?? {}, key)
          )
        ) {
          throw new DocumentError("invalid_content");
        }
        visit(child);
      } else if (child instanceof XmlText) {
        validateTextMarks(child);
      } else {
        throw new DocumentError("invalid_content");
      }
    }
  };
  visit(fragment);
  const raw = yXmlFragmentToProseMirrorRootNode(fragment, schema);
  raw.check();
  const clean = schema.nodeFromJSON(sanitizeJSON(raw.toJSON(), policy));
  if (!raw.eq(clean)) {
    throw new DocumentError("invalid_content");
  }
  return clean.toJSON();
}
/** One controller per room Doc. Browser editors use the shared schema and Yjs binding directly. */
export class LiveDocument {
  readonly fragment: XmlFragment;
  private revision: number;
  private blocks: Block[] = [];
  private readonly history = new Map<
    number,
    Outline & { tombstones: [string, number][] }
  >();
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
    if (
      !Number.isSafeInteger(this.revision) ||
      this.revision < 0 ||
      (options.historyLimit !== undefined &&
        (!Number.isInteger(options.historyLimit) || options.historyLimit < 1))
    ) {
      throw new DocumentError("invalid_content");
    }
    if (this.fragment.length) {
      validatedJSON(doc, options);
    }
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
          prior.index !== block.index ||
          prior.parentId !== block.parentId
        ) {
          this.changedAt.set(block.id, this.revision);
        }
        this.deletedAt.delete(block.id);
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
            index: blocks.length,
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
        tombstones: [...this.deletedAt],
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
        ? {
            blocks: this.blocks,
            deleted: [],
            revision: this.revision,
            tombstones: [...this.deletedAt],
          }
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
          : snapshot.tombstones
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
    const available = new Map<string, string[]>();
    const used = new Set<string>();
    const visit = (node: JSONContent, collect: (node: JSONContent) => void) => {
      collect(node);
      for (const child of node.content ?? []) {
        visit(child, collect);
      }
    };
    visit(this.json(), (node) => {
      if (typeof node.attrs?.id === "string") {
        const key = hashBlock(node);
        const ids = available.get(key) ?? [];
        ids.push(node.attrs.id);
        available.set(key, ids);
      }
    });
    visit(clean, (node) => {
      if (typeof node.attrs?.id === "string") {
        used.add(node.attrs.id);
      }
    });
    visit(clean, (node) => {
      if (!BLOCK_TYPES.includes(node.type ?? "") || node.attrs?.id) {
        return;
      }
      const retained = available
        .get(hashBlock(node))
        ?.find((candidate) => !used.has(candidate));
      const id = retained ?? crypto.randomUUID();
      used.add(id);
      node.attrs = { ...node.attrs, id };
    });
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
      validatedJSON(replica, this.options);
    } catch (cause) {
      // biome-ignore lint/style/useErrorCause: DocumentError preserves the cause through its third argument.
      throw new DocumentError("invalid_content", undefined, { cause });
    } finally {
      replica.destroy();
    }
    applyUpdate(this.doc, update, origin);
  }
  /** Restore checkpoint CONTENT as a new origin change, rather than merging old CRDT tombstones into the room. */
  restoreSnapshot(update: Uint8Array, origin: unknown) {
    const snapshot = new Doc();
    try {
      applyUpdate(snapshot, update);
      this.import({ json: validatedJSON(snapshot, this.options) }, origin);
    } finally {
      snapshot.destroy();
    }
  }
  anchor(blockId: string, from: number, to: number): CommentAnchor {
    if (from >= to) {
      throw new DocumentError("invalid_position");
    }
    return {
      detached: false,
      end: this.position(blockId, to, -1),
      kind: "document",
      start: this.position(blockId, from, 0),
    };
  }
  resolveAnchor(anchor: Extract<CommentAnchor, { kind: "document" }>): {
    detached: boolean;
    start?: AbsolutePosition;
    end?: AbsolutePosition;
  } {
    try {
      const start = this.resolve(anchor.start);
      const end = this.resolve(anchor.end);
      return {
        detached:
          this.inlineLocation(start).block !== this.inlineLocation(end).block ||
          this.inlineLocation(start).offset >= this.inlineLocation(end).offset,
        end,
        start,
      };
    } catch {
      return { detached: true };
    }
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
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !schema.nodes[el.nodeName]?.inlineContent
    ) {
      throw new DocumentError("invalid_position");
    }
    let remaining = offset;
    const children = el.toArray();
    for (const child of children) {
      if (child instanceof XmlText) {
        if (remaining <= child.length) {
          return relativePositionToJSON(
            createRelativePositionFromTypeIndex(child, remaining, assoc)
          );
        }
        remaining -= child.length;
      } else if (child instanceof XmlElement) {
        const width =
          child.nodeName === "hardBreak"
            ? 1
            : String(child.getAttribute("label") ?? "").length;
        remaining -= width;
        if (remaining < 0) {
          throw new DocumentError("invalid_position");
        }
      }
    }
    if (remaining === 0) {
      return relativePositionToJSON(
        createRelativePositionFromTypeIndex(el, children.length, assoc)
      );
    }
    throw new DocumentError("invalid_position");
  }
  resolve(position: RelativePositionJSON): AbsolutePosition {
    const absolute = createAbsolutePositionFromRelativePosition(
      createRelativePositionFromJSON(position),
      this.doc
    );
    if (
      !(
        absolute &&
        (absolute.type instanceof XmlText ||
          (absolute.type instanceof XmlElement &&
            schema.nodes[absolute.type.nodeName]?.inlineContent))
      ) ||
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
      throw new DocumentError("find_none");
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
      throw new DocumentError("find_none");
    }
    return match;
  }
  private inlineLocation(position: AbsolutePosition): {
    block: XmlElement;
    offset: number;
  } {
    const block =
      position.type instanceof XmlText ? position.type.parent : position.type;
    if (
      !(
        block instanceof XmlElement &&
        schema.nodes[block.nodeName]?.inlineContent
      )
    ) {
      throw new DocumentError("invalid_position");
    }
    let offset = 0;
    const children = block.toArray();
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (child === position.type) {
        return { block, offset: offset + position.index };
      }
      if (position.type === block && index === position.index) {
        return { block, offset };
      }
      if (child instanceof XmlText) {
        offset += child.length;
      } else if (child instanceof XmlElement) {
        offset +=
          child.nodeName === "hardBreak"
            ? 1
            : String(child.getAttribute("label") ?? "").length;
      }
    }
    if (position.type === block && position.index === children.length) {
      return { block, offset };
    }
    throw new DocumentError("invalid_position");
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
          this.inlineLocation(a).block !== this.inlineLocation(b).block ||
          (from < this.inlineLocation(b).offset &&
            to !== undefined &&
            to > this.inlineLocation(a).offset))
      ) {
        throw new DocumentError("comment_anchor");
      }
    }
  }
  /** Replayable undo record: room storage owns retention, access checks and changeId idempotency. */
  capture(
    ops: Operation[],
    origin: LiveOperationOrigin
  ): { revision: number; change: CapturedChange } {
    const before = encodeStateAsUpdate(this.doc);
    const vector = encodeStateVector(this.doc);
    const result = this.apply(ops, origin);
    return {
      change: {
        before,
        changeId: origin.changeId,
        update: encodeStateAsUpdate(this.doc, vector),
      },
      revision: result.revision,
    };
  }
  /** Rebuild only this change's origin history, merge current human edits, then publish its selective undo delta. */
  revert(change: CapturedChange, origin: object): { revision: number } {
    const replica = new Doc({ gc: false });
    let undo: UndoManager | undefined;
    try {
      applyUpdate(replica, change.before);
      const trackedOrigin = {};
      undo = createOriginUndo(replica, trackedOrigin);
      applyUpdate(replica, change.update, trackedOrigin);
      applyUpdate(replica, encodeStateAsUpdate(this.doc), "current");
      const vector = encodeStateVector(replica);
      undo.undo();
      this.applyUpdate(encodeStateAsUpdate(replica, vector), origin);
      return { revision: this.revision };
    } finally {
      undo?.destroy();
      replica.destroy();
    }
  }
  /** All-or-nothing batch: a disposable replica preflights every op, then one live origin transaction. */
  apply(
    ops: Operation[],
    origin: LiveOperationOrigin | object
  ): { revision: number; changeId?: string } {
    if ("mode" in origin && origin.mode !== "direct") {
      throw new DocumentError("invalid_content");
    }
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
      if (at.type instanceof XmlText) {
        at.type.insert(at.index, op.content.text);
      } else {
        const text = new XmlText();
        text.insert(0, op.content.text);
        (at.type as XmlElement).insert(at.index, [text]);
      }
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
        this.protect(this.element(match.block.id), match.start, match.end);
        if (!(start.type instanceof XmlText)) {
          throw new DocumentError("invalid_position");
        }
        const text = start.type;
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
        if (BLOCK_TYPES.includes(node.type ?? "")) {
          node.attrs = { ...node.attrs, id: elementId(el) };
        }
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
          if (
            ["bulletList", "orderedList", "taskList"].includes(op.type) &&
            ["bulletList", "orderedList", "taskList"].includes(node.type ?? "")
          ) {
            for (const item of node.content ?? []) {
              item.type = op.type === "taskList" ? "taskItem" : "listItem";
            }
          }
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
        if (op.action === "deleteRow" || op.action === "deleteColumn") {
          this.protect(this.element(id));
        }
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
    if (!json.content?.length) {
      json.content = [{ type: "paragraph" }];
    }
    // Structural edits must remain valid before sanitation; reject rather than
    // silently dropping a list/table when a move or conversion is incompatible.
    try {
      schema.nodeFromJSON(json).check();
    } catch (cause) {
      // biome-ignore lint/style/useErrorCause: DocumentError preserves the cause through its third argument.
      throw new DocumentError("invalid_content", undefined, { cause });
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
