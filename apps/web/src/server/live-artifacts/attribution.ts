import type { LiveDocument } from "@repo/live-doc";
import {
  type RelativePositionJSON,
  relativePositionSchema,
} from "@repo/protocol/live";
import {
  ContentString,
  createRelativePositionFromTypeIndex,
  decodeUpdate,
  Item,
  relativePositionToJSON,
  XmlElement,
  type XmlFragment,
  XmlText,
} from "yjs";

const serializePosition = (
  position: ReturnType<typeof createRelativePositionFromTypeIndex>
) => relativePositionSchema.parse(relativePositionToJSON(position));
export interface AgentRange {
  end: RelativePositionJSON;
  id: string;
  name: string;
  start: RelativePositionJSON;
  text: string;
}
/** Attribute only surviving characters whose CRDT IDs were inserted by the
 * retained operation update. Human insertions and identical replacement text
 * have different IDs and cannot acquire attribution through text matching. */
export const insertedRanges = (
  live: LiveDocument,
  update: Uint8Array,
  actor: { id: string; name: string }
): AgentRange[] => {
  const clients = new Map<number, Array<{ start: number; end: number }>>();
  for (const struct of decodeUpdate(update).structs) {
    if (!(struct instanceof Item && struct.content instanceof ContentString)) {
      continue;
    }
    const spans = clients.get(struct.id.client) ?? [];
    spans.push({
      end: struct.id.clock + struct.length,
      start: struct.id.clock,
    });
    clients.set(struct.id.client, spans);
  }
  const result: AgentRange[] = [];
  const appendItemRanges = (text: XmlText, item: Item, offset: number) => {
    if (item.content instanceof ContentString) {
      for (const span of clients.get(item.id.client) ?? []) {
        const start = Math.max(item.id.clock, span.start),
          end = Math.min(item.id.clock + item.length, span.end);
        if (start >= end) {
          continue;
        }
        const from = offset + start - item.id.clock,
          to = offset + end - item.id.clock;
        result.push({
          ...actor,
          end: serializePosition(
            createRelativePositionFromTypeIndex(text, to, -1)
          ),
          start: serializePosition(
            createRelativePositionFromTypeIndex(text, from, 0)
          ),
          text: item.content.str.slice(
            start - item.id.clock,
            end - item.id.clock
          ),
        });
      }
    }
  };
  const textRanges = (text: XmlText) => {
    let offset = 0;
    for (let item = text._start; item; item = item.right) {
      if (item.deleted) {
        continue;
      }
      appendItemRanges(text, item, offset);
      if (item.countable) {
        offset += item.length;
      }
    }
  };
  const visit = (parent: XmlFragment | XmlElement) => {
    for (const child of parent.toArray()) {
      if (child instanceof XmlText) {
        textRanges(child);
      } else if (child instanceof XmlElement) {
        visit(child);
      }
    }
  };
  visit(live.fragment);
  return result.map((range, i) => ({ ...range, id: `${actor.id}:${i}` }));
};
