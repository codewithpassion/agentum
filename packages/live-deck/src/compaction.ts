import {
  ContentDeleted,
  ContentType,
  createDeleteSetFromStructStore,
  type Doc,
  tryGc,
} from "yjs";
import { liveReferences, type Usage } from "./migrations";

/**
 * Drops deleted payloads in place and keeps the ancestry live migration records
 * still point at. Struct ids and clocks do not change, so connected peers keep
 * a valid state vector and need no resync. Returns what the live records use.
 */
export function compactDoc(doc: Doc): Usage {
  const { items, usage } = liveReferences(doc);
  for (const kept of items) {
    // A kept leaf only has to stay an Item with its parent; its bytes can go.
    if (kept.deleted && !(kept.content instanceof ContentType)) {
      kept.content = new ContentDeleted(kept.length);
    }
  }
  // gcFilter spares kept items. Types are spared whole, which also spares
  // their ancestors, so ContentType.gc never reaches a kept descendant.
  tryGc(
    createDeleteSetFromStructStore(doc.store),
    doc.store,
    (candidate) => !items.has(candidate)
  );
  return usage;
}
