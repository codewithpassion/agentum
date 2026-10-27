import { DocumentError, type LiveDocument } from "@repo/live-doc";
import type { CommentAnchor, RelativePositionJSON } from "@repo/protocol/live";
import {
  createRelativePositionFromTypeIndex,
  XmlElement,
  type XmlFragment,
  XmlText,
} from "yjs";

interface Range {
  end: RelativePositionJSON;
  start: RelativePositionJSON;
}
type Node = XmlElement | XmlText;
/** Project visible inline text and CRDT character IDs, without converting positions to editor offsets. */
class TextProjection {
  text = "";
  readonly tokens: string[] = [];
  readonly offsets = new Map<XmlFragment | XmlText, number[]>();
  constructor(live: LiveDocument) {
    this.walk(live.fragment);
  }
  private addText(node: XmlText, positions: number[]) {
    for (const delta of node.toDelta()) {
      if (typeof delta.insert !== "string") {
        throw new DocumentError("invalid_content");
      }
      // split("") deliberately preserves UTF-16 indexing used by Yjs positions.
      for (const character of delta.insert.split("")) {
        const { item } = createRelativePositionFromTypeIndex(
          node,
          positions.length - 1
        );
        this.tokens.push(item ? `${item.client}:${item.clock}` : "");
        this.text += character;
        positions.push(this.text.length);
      }
    }
  }
  private addAtom(node: XmlElement) {
    const label =
      node.nodeName === "hardBreak" ? "\n" : (node.getAttribute("label") ?? "");
    this.text += label;
    for (let i = 0; i < label.length; i += 1) {
      this.tokens.push(
        `atom:${node._item?.id.client}:${node._item?.id.clock}:${i}`
      );
    }
  }
  private walk(node: Node | XmlFragment) {
    const positions = [this.text.length];
    if (node instanceof XmlText) {
      this.addText(node, positions);
    } else {
      for (const child of node.toArray()) {
        if (!(child instanceof XmlElement || child instanceof XmlText)) {
          throw new DocumentError("invalid_content");
        }
        this.walk(child);
        positions.push(this.text.length);
      }
      if (node instanceof XmlElement && node.length === 0) {
        this.addAtom(node);
      }
    }
    this.offsets.set(node, positions);
  }
}

function selected(live: LiveDocument, range: Range) {
  const resolved = live.resolveAnchor({
    ...range,
    detached: false,
    kind: "document",
  });
  if (resolved.detached || !resolved.start || !resolved.end) {
    return null;
  }
  const view = new TextProjection(live);
  const start = view.offsets.get(resolved.start.type as XmlText)?.[
    resolved.start.index
  ];
  const end = view.offsets.get(resolved.end.type as XmlText)?.[
    resolved.end.index
  ];
  if (start === undefined || end === undefined || start >= end) {
    return null;
  }
  return {
    quote: view.text.slice(start, end),
    tokens: view.tokens.slice(start, end),
  };
}
export function resolveDocumentAnchor(
  live: LiveDocument,
  anchor: CommentAnchor
) {
  if (anchor.kind !== "document") {
    throw new DocumentError("invalid_position");
  }
  const range = selected(live, anchor);
  return {
    anchor: { ...anchor, detached: range === null },
    quote: range?.quote ?? null,
  };
}
/** Fail closed when an active anchored CRDT character disappears, even if identical text replaces it. */
export function guardAnchoredWords(
  before: LiveDocument,
  after: LiveDocument,
  ranges: Range[]
) {
  for (const range of ranges) {
    const prior = selected(before, range);
    if (!prior) {
      continue;
    } // already detached comments do not freeze unrelated content
    const next = selected(after, range);
    if (!next) {
      throw new DocumentError("comment_anchor");
    }
    const retained = new Set(next.tokens);
    if (prior.tokens.some((token) => !retained.has(token))) {
      throw new DocumentError("comment_anchor");
    }
  }
}
