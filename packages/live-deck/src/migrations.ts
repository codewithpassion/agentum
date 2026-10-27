import {
  AbstractType,
  ContentAny,
  ContentType,
  type Doc,
  getItem,
  getState,
  ID,
  Item,
  XmlElement,
  XmlFragment,
  XmlText,
  Map as YMap,
} from "yjs";

const ROOT = /^__tiptap_position_migrations:item:(0|[1-9]\d*):(0|[1-9]\d*)$/;
const CELL = /^(0|[1-9]\d*):(0|[1-9]\d*)$/;
const reject = (): never => {
  throw new Error("invalid_deck_position_migration");
};
function integer(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 0xff_ff_ff_ff
  ) {
    return reject();
  }
  return value;
}
function record(value: unknown, allowed: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).some((key) => !allowed.includes(key))
  ) {
    return reject();
  }
  return value as Record<string, unknown>;
}
function identity(value: unknown): ID {
  // The binding supplies Y.ID locally; Yjs decodes the wire value as plain JSON.
  if (value instanceof ID) {
    if (Object.keys(value).some((key) => key !== "client" && key !== "clock")) {
      return reject();
    }
    return new ID(integer(value.client), integer(value.clock));
  }
  const v = record(value, ["client", "clock"]);
  return new ID(integer(v.client), integer(v.clock));
}
function item(doc: Doc, id: ID): Item {
  if (id.clock >= getState(doc.store, id.client)) {
    return reject();
  }
  const found = getItem(doc.store, id);
  if (!(found instanceof Item)) {
    return reject();
  }
  return found;
}
function parent(value: Item): AbstractType<unknown> {
  if (!(value.parent instanceof AbstractType)) {
    return reject();
  }
  return value.parent;
}
/** Only actual nested scene text/cell fragments, including retained deleted history. */
function fragmentFor(doc: Doc, id: ID): XmlFragment {
  const entry = item(doc, id);
  if (
    entry.id.clock !== id.clock ||
    !(entry.content instanceof ContentType) ||
    entry.content.type.constructor !== XmlFragment
  ) {
    return reject();
  }
  const fragment = entry.content.type as XmlFragment;
  let element: AbstractType<unknown>;
  if (entry.parentSub === "text") {
    element = parent(entry);
  } else {
    if (!(entry.parentSub && CELL.test(entry.parentSub))) {
      return reject();
    }
    const cells = parent(entry);
    if (!(cells instanceof YMap) || cells._item?.parentSub !== "cells") {
      return reject();
    }
    element = parent(cells._item);
  }
  if (!(element instanceof YMap && element._item)) {
    return reject();
  }
  const elements = parent(element._item);
  if (!(elements instanceof YMap) || elements._item?.parentSub !== "elements") {
    return reject();
  }
  const slide = parent(elements._item);
  if (
    !(slide instanceof YMap && slide._item) ||
    parent(slide._item) !== doc.getMap("slides")
  ) {
    return reject();
  }
  return fragment;
}
function within(value: Item, fragment: XmlFragment): boolean {
  let type = parent(value);
  for (let depth = 0; depth < 64; depth += 1) {
    if (type === fragment) {
      return true;
    }
    if (
      !((type instanceof XmlElement || type instanceof XmlText) && type._item)
    ) {
      return false;
    }
    type = parent(type._item);
  }
  return false;
}
function range(doc: Doc, fragment: XmlFragment, id: ID, length: number): Item {
  const first = item(doc, id);
  let { clock } = id;
  const end = clock + length;
  while (clock < end) {
    const part = item(doc, new ID(id.client, clock));
    if (part.parentSub !== null || !within(part, fragment)) {
      return reject();
    }
    clock = part.id.clock + part.length;
  }
  return first;
}
interface Budget {
  positions: number;
  records: number;
  transfers: number;
  vectors: number;
}
function transfer(
  doc: Doc,
  fragment: XmlFragment,
  input: unknown,
  budget: Budget
) {
  const value = record(input, ["source", "target"]);
  const source = record(value.source, [
    "client",
    "clock",
    "length",
    "boundary",
  ]);
  const length = integer(source.length);
  budget.positions += length;
  if (!length || budget.positions > 2_000_000) {
    return reject();
  }
  boundary(source.boundary);
  range(
    doc,
    fragment,
    new ID(integer(source.client), integer(source.clock)),
    length
  );
  if (value.target === null) {
    return;
  }
  const target = record(value.target, [
    "client",
    "clock",
    "type",
    "assoc",
    "boundary",
  ]);
  boundary(target.boundary);
  if (target.assoc !== undefined && target.assoc !== -1 && target.assoc !== 0) {
    return reject();
  }
  const destination = range(
    doc,
    fragment,
    new ID(integer(target.client), integer(target.clock)),
    length
  );
  if (target.type === null) {
    // Upstream merges adjacent node-boundary transfers just like characters.
    if (target.boundary === undefined) {
      return reject();
    }
  } else {
    const type = identity(target.type);
    const actual = parent(destination)._item?.id;
    if (
      !actual ||
      actual.client !== type.client ||
      actual.clock !== type.clock
    ) {
      return reject();
    }
  }
}
function boundary(value: unknown) {
  if (value !== undefined && value !== "start" && value !== "end") {
    reject();
  }
}
function migration(
  doc: Doc,
  fragment: XmlFragment,
  entry: Item,
  key: string,
  input: unknown,
  budget: Budget
) {
  const value = record(input, [
    "version",
    "client",
    "clock",
    "seen",
    "transfers",
  ]);
  const client = integer(value.client);
  const clock = integer(value.clock);
  if (
    value.version !== 1 ||
    key !== `${client}:${clock}` ||
    entry.id.client !== client ||
    entry.id.clock !== clock
  ) {
    return reject();
  }
  if (!(Array.isArray(value.seen) && Array.isArray(value.transfers))) {
    return reject();
  }
  budget.records += 1;
  budget.vectors += value.seen.length;
  budget.transfers += value.transfers.length;
  if (
    budget.records > 10_000 ||
    budget.vectors > 100_000 ||
    budget.transfers > 100_000
  ) {
    return reject();
  }
  const seen = new Set<number>();
  for (const pair of value.seen) {
    if (!Array.isArray(pair) || pair.length !== 2) {
      return reject();
    }
    const c = integer(pair[0]);
    if (seen.has(c) || integer(pair[1]) > getState(doc.store, c)) {
      return reject();
    }
    seen.add(c);
  }
  for (const transferValue of value.transfers) {
    transfer(doc, fragment, transferValue, budget);
  }
}
/** y-tiptap 3.0.10's closed v1 history grammar. Never allow a prefix-only hidden root. */
export function validatePositionMigrations(doc: Doc): Set<string> {
  const accepted = new Set<string>();
  const budget: Budget = { positions: 0, records: 0, transfers: 0, vectors: 0 };
  for (const name of doc.share.keys()) {
    const match = ROOT.exec(name);
    if (!match) {
      continue;
    }
    const fragment = fragmentFor(
      doc,
      new ID(integer(Number(match[1])), integer(Number(match[2])))
    );
    const store = doc.getMap(name);
    if (store._start !== null || accepted.size >= 20_000) {
      return reject();
    }
    // Visible entries alone miss same-transaction insert/delete payloads. With
    // gc disabled every retained map value must satisfy the closed grammar.
    for (const [key, latest] of store._map) {
      for (let entry: Item | null = latest; entry; entry = entry.left) {
        if (
          !(entry.content instanceof ContentAny) ||
          entry.content.arr.length !== 1
        ) {
          return reject();
        }
        migration(doc, fragment, entry, key, entry.content.arr[0], budget);
      }
    }
    accepted.add(name);
  }
  return accepted;
}
