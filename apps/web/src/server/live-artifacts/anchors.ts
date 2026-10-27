import { DocumentError, type LiveDocument } from "@repo/live-doc";
import type { CommentAnchor, RelativePositionJSON } from "@repo/protocol/live";
import { XmlElement, type XmlFragment, XmlText } from "yjs";

interface Range {
  end: RelativePositionJSON;
  start: RelativePositionJSON;
}
interface CharacterRange {
  client: number;
  end: number;
  start: number;
}
interface Location {
  children?: number[];
  start: number;
}
interface Leaf {
  end: number;
  node: XmlText | XmlElement;
  start: number;
}
type Node = XmlElement | XmlText;

/** Project offsets by text run, never allocate one token/offset per document character. */
class TextProjection {
  private readonly parts: string[] = [];
  private length = 0;
  private text: string | undefined;
  readonly leaves: Leaf[] = [];
  readonly offsets = new Map<XmlFragment | XmlText, Location>();
  constructor(live: LiveDocument) {
    this.walk(live.fragment);
  }
  private append(text: string) {
    this.parts.push(text);
    this.length += text.length;
  }
  private walk(node: Node | XmlFragment) {
    const start = this.length;
    if (node instanceof XmlText) {
      for (const delta of node.toDelta()) {
        if (typeof delta.insert !== "string") {
          throw new DocumentError("invalid_content");
        }
        this.append(delta.insert);
      }
      this.leaves.push({ end: this.length, node, start });
      this.offsets.set(node, { start });
      return;
    }
    const children = [start];
    for (const child of node.toArray()) {
      if (!(child instanceof XmlElement || child instanceof XmlText)) {
        throw new DocumentError("invalid_content");
      }
      this.walk(child);
      children.push(this.length);
    }
    if (node instanceof XmlElement && node.length === 0) {
      this.append(
        node.nodeName === "hardBreak"
          ? "\n"
          : (node.getAttribute("label") ?? "")
      );
      this.leaves.push({ end: this.length, node, start });
    }
    this.offsets.set(node, { children, start });
  }
  offset(type: unknown, index: number) {
    const location = this.offsets.get(type as XmlText);
    if (!location) {
      return;
    }
    return location.children
      ? location.children[index]
      : location.start + index;
  }
  select(start: number, end: number) {
    const tokens: CharacterRange[] = [];
    for (const leaf of this.leaves) {
      if (leaf.start >= end || leaf.end <= start) {
        continue;
      }
      if (leaf.node instanceof XmlText) {
        tokens.push(
          ...textCharacterRanges(
            leaf.node,
            Math.max(0, start - leaf.start),
            Math.min(leaf.end - leaf.start, end - leaf.start)
          )
        );
      } else {
        const item = leaf.node._item;
        if (item) {
          tokens.push({
            client: item.id.client,
            end: item.id.clock + 1,
            start: item.id.clock,
          });
        }
      }
    }
    this.text ??= this.parts.join("");
    return {
      quote: this.text.slice(start, end),
      tokens,
    };
  }
}
/** Yjs is pinned. Walk its countable, undeleted runs so protection is O(structs), including multi-MiB text. */
function textCharacterRanges(
  node: XmlText,
  from: number,
  to: number
): CharacterRange[] {
  const ranges: CharacterRange[] = [];
  let offset = 0;
  for (let item = node._start; item; item = item.right) {
    if (item.deleted || !item.countable) {
      continue;
    }
    const start = Math.max(from, offset);
    const end = Math.min(to, offset + item.length);
    if (start < end) {
      ranges.push({
        client: item.id.client,
        end: item.id.clock + end - offset,
        start: item.id.clock + start - offset,
      });
    }
    offset += item.length;
    if (offset >= to) {
      break;
    }
  }
  return ranges;
}
function selected(
  live: LiveDocument,
  range: Range,
  view = new TextProjection(live)
) {
  const resolved = live.resolveAnchor({
    ...range,
    detached: false,
    kind: "document",
  });
  if (resolved.detached || !resolved.start || !resolved.end) {
    return null;
  }
  const start = view.offset(resolved.start.type, resolved.start.index);
  const end = view.offset(resolved.end.type, resolved.end.index);
  if (start === undefined || end === undefined || start >= end) {
    return null;
  }
  return view.select(start, end);
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
function containsCharacters(before: CharacterRange[], after: CharacterRange[]) {
  const ordered = after.toSorted(
    (a, b) => a.client - b.client || a.start - b.start
  );
  return before.every((prior) => {
    let cursor = prior.start;
    for (const next of ordered) {
      if (next.client !== prior.client || next.start > cursor) {
        continue;
      }
      cursor = Math.max(cursor, next.end);
      if (cursor >= prior.end) {
        return true;
      }
    }
    return false;
  });
}
/** Identical replacement text cannot conceal deletion of an anchored CRDT character. */
export function guardAnchoredWords(
  before: LiveDocument,
  after: LiveDocument,
  ranges: Range[]
) {
  if (!ranges.length) {
    return;
  }
  const beforeView = new TextProjection(before);
  const afterView = new TextProjection(after);
  for (const range of ranges) {
    const prior = selected(before, range, beforeView);
    if (!prior) {
      continue;
    }
    const next = selected(after, range, afterView);
    if (!(next && containsCharacters(prior.tokens, next.tokens))) {
      throw new DocumentError("comment_anchor");
    }
  }
}
