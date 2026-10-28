import { DECK_STALE_ANCESTRY } from "@repo/protocol/deck";
import {
  AbstractType,
  ContentAny,
  ContentDeleted,
  ContentType,
  type Doc,
  GC,
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
/** The update names history compaction already removed, so the sender must reload. */
export class StaleAncestryError extends Error {
  constructor() {
    super(DECK_STALE_ANCESTRY);
    this.name = "StaleAncestryError";
  }
}
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
  if (found instanceof GC) {
    throw new StaleAncestryError();
  }
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
function wasCollected(doc: Doc, id: ID): boolean {
  if (id.clock >= getState(doc.store, id.client)) {
    return false;
  }
  const found = getItem(doc.store, id);
  // A collected type under a live parent stays an Item with its content dropped.
  return found instanceof GC || found.content instanceof ContentDeleted;
}
/** Only actual nested scene text/cell fragments, including retained deleted history. */
function fragmentFor(doc: Doc, id: ID, collected: boolean): XmlFragment | null {
  // Compaction may have dropped a fragment no live record refers to any more.
  if (collected && wasCollected(doc, id)) {
    return null;
  }
  const entry = item(doc, id);
  if (entry.content instanceof ContentDeleted) {
    throw new StaleAncestryError();
  }
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
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
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
function heldBy(part: Item, holder: ID): boolean {
  const actual = parent(part)._item?.id;
  return actual?.client === holder.client && actual.clock === holder.clock;
}
function range(
  doc: Doc,
  fragment: XmlFragment,
  id: ID,
  length: number,
  holder?: ID
): void {
  let { clock } = id;
  const end = clock + length;
  while (clock < end) {
    const part = item(doc, new ID(id.client, clock));
    if (part.parentSub !== null || !within(part, fragment)) {
      reject();
    }
    if (holder && !heldBy(part, holder)) {
      reject();
    }
    clock = part.id.clock + part.length;
  }
}
/** Counts of what migration records ask the validator and clients to walk. */
export interface Usage {
  positions: number;
  records: number;
  transfers: number;
  vectors: number;
}
export const emptyUsage = (): Usage => ({
  positions: 0,
  records: 0,
  transfers: 0,
  vectors: 0,
});
/** What one checkpoint window (the span between compactions) may add. */
export const WINDOW_CAPS: Readonly<Usage> = {
  positions: 2_000_000,
  records: 10_000,
  transfers: 100_000,
  vectors: 100_000,
};
const LIFETIME_FACTOR = 32;
/** Live records survive compaction, so the whole deck gets a ceiling too. */
export const LIFETIME_CAPS: Readonly<Usage> = {
  positions: WINDOW_CAPS.positions * LIFETIME_FACTOR,
  records: WINDOW_CAPS.records * LIFETIME_FACTOR,
  transfers: WINDOW_CAPS.transfers * LIFETIME_FACTOR,
  vectors: WINDOW_CAPS.vectors * LIFETIME_FACTOR,
};
export const isMigrationRoot = (name: string) => ROOT.test(name);
const MAX_ROOTS = 20_000;
const MAX_DEPTH = 64;
/** A cap was hit. Compaction opens a new window, so the caller may retry once. */
export class CapacityError extends Error {
  constructor(message = "invalid_deck_position_migration") {
    super(message);
    this.name = "CapacityError";
  }
}
function charge(usage: Usage, allow: Usage) {
  if (
    usage.positions > allow.positions ||
    usage.records > allow.records ||
    usage.transfers > allow.transfers ||
    usage.vectors > allow.vectors
  ) {
    throw new CapacityError();
  }
}
function transfer(
  doc: Doc,
  fragment: XmlFragment,
  input: unknown,
  usage: Usage,
  allow: Usage
) {
  const value = record(input, ["source", "target"]);
  const source = record(value.source, [
    "client",
    "clock",
    "length",
    "boundary",
  ]);
  const length = integer(source.length);
  usage.positions += length;
  if (!length) {
    return reject();
  }
  charge(usage, allow);
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
  const holder = target.type === null ? undefined : identity(target.type);
  range(
    doc,
    fragment,
    new ID(integer(target.client), integer(target.clock)),
    length,
    holder
  );
  // Upstream merges adjacent node-boundary transfers just like characters.
  if (target.type === null && target.boundary === undefined) {
    return reject();
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
  usage: Usage,
  allow: Usage
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
  usage.records += 1;
  usage.vectors += value.seen.length;
  usage.transfers += value.transfers.length;
  charge(usage, allow);
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
    transfer(doc, fragment, transferValue, usage, allow);
  }
}
const rootId = (name: string) => {
  const match = ROOT.exec(name) as RegExpExecArray;
  return new ID(integer(Number(match[1])), integer(Number(match[2])));
};
function migrationRoots(doc: Doc): Map<AbstractType<unknown>, string> {
  const stores = new Map<AbstractType<unknown>, string>();
  for (const name of doc.share.keys()) {
    if (ROOT.test(name)) {
      // getMap converts a decoded placeholder and repoints the items at it.
      stores.set(doc.getMap(name) as AbstractType<unknown>, name);
    }
  }
  if (stores.size > MAX_ROOTS) {
    reject();
  }
  return stores;
}
function* allEntries(stores: Map<AbstractType<unknown>, string>) {
  for (const [store, name] of stores) {
    if (store._start !== null) {
      reject();
    }
    // Visible entries alone miss same-transaction insert/delete payloads. With
    // gc disabled every retained map value must satisfy the closed grammar.
    for (const latest of store._map.values()) {
      for (let entry: Item | null = latest; entry; entry = entry.left) {
        yield [name, entry] as const;
      }
    }
  }
}
/** Only structs an update added: cost follows the update, never the history. */
function* newEntries(
  doc: Doc,
  stores: Map<AbstractType<unknown>, string>,
  since: ReadonlyMap<number, number>
) {
  for (const store of stores.keys()) {
    if (store._start !== null) {
      reject();
    }
  }
  for (const [client, structs] of doc.store.clients) {
    const from = since.get(client) ?? 0;
    if (getState(doc.store, client) <= from) {
      continue;
    }
    let low = 0;
    let high = structs.length - 1;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const probe = structs[mid] as Item | GC;
      if (probe.id.clock + probe.length > from) {
        high = mid;
      } else {
        low = mid + 1;
      }
    }
    for (let index = low; index < structs.length; index += 1) {
      const struct = structs[index];
      if (!(struct instanceof Item && struct.parent instanceof AbstractType)) {
        continue;
      }
      const name = stores.get(struct.parent);
      if (name !== undefined) {
        yield [name, struct] as const;
      }
    }
  }
}
export interface ScanOptions {
  /** Most this scan may add before it throws CapacityError. */
  allow: Usage;
  /** Clocks the validator already saw. Omit to scan the whole document. */
  since?: ReadonlyMap<number, number>;
  /** Roots an earlier scan proved against their fragment. */
  verified?: ReadonlySet<string>;
}
export interface Scan {
  roots: Set<string>;
  usage: Usage;
}
function retainsPayload(store: AbstractType<unknown>): boolean {
  for (const latest of store._map.values()) {
    for (let entry: Item | null = latest; entry; entry = entry.left) {
      if (entry.content instanceof ContentAny) {
        return true;
      }
    }
  }
  return false;
}
/** y-tiptap 3.0.10's closed v1 history grammar. Never allow a prefix-only hidden root. */
export function validatePositionMigrations(
  doc: Doc,
  options: ScanOptions
): Scan {
  const stores = migrationRoots(doc);
  const usage = emptyUsage();
  const fragments = new Map<string, XmlFragment>();
  const entries = options.since
    ? newEntries(doc, stores, options.since)
    : allEntries(stores);
  for (const [name, entry] of entries) {
    if (entry.parentSub === null) {
      return reject();
    }
    if (entry.content instanceof ContentDeleted) {
      continue; // Collected payload: nothing is left to validate.
    }
    if (
      !(entry.content instanceof ContentAny) ||
      entry.content.arr.length !== 1
    ) {
      return reject();
    }
    let fragment = fragments.get(name);
    if (!fragment) {
      fragment = fragmentFor(doc, rootId(name), false) as XmlFragment;
      fragments.set(name, fragment);
    }
    migration(
      doc,
      fragment,
      entry,
      entry.parentSub,
      entry.content.arr[0],
      usage,
      options.allow
    );
  }
  const roots = new Set<string>();
  for (const [store, name] of stores) {
    roots.add(name);
    if (!(fragments.has(name) || options.verified?.has(name))) {
      fragmentFor(doc, rootId(name), !retainsPayload(store));
    }
  }
  return { roots, usage };
}
type Cover = (client: unknown, clock: unknown, length: unknown) => void;
function countRecord(input: unknown, usage: Usage, cover: Cover) {
  const value = input as Record<string, unknown>;
  const seen = value.seen as unknown[];
  const transfers = value.transfers as {
    source: Record<string, number>;
    target: Record<string, number> | null;
  }[];
  usage.records += 1;
  usage.vectors += seen.length;
  usage.transfers += transfers.length;
  for (const { source, target } of transfers) {
    usage.positions += source.length as number;
    cover(source.client, source.clock, source.length);
    if (target) {
      cover(target.client, target.clock, source.length);
    }
  }
}
function collect(
  doc: Doc,
  intervals: Map<number, [number, number][]>,
  items: Set<Item>
) {
  for (const [client, list] of intervals) {
    list.sort((a, b) => a[0] - b[0]);
    let clock = 0;
    for (const [start, end] of list) {
      clock = Math.max(clock, start);
      while (clock < end && clock < getState(doc.store, client)) {
        const part = getItem(doc.store, new ID(client, clock));
        if (part instanceof Item) {
          items.add(part);
        }
        clock = part.id.clock + part.length;
      }
    }
  }
  for (const start of [...items]) {
    let up = start.parent;
    while (up instanceof AbstractType && up._item && !items.has(up._item)) {
      items.add(up._item);
      up = up._item.parent;
    }
  }
}
interface Held {
  items: Set<Item>;
  usage: Usage;
}
/** Items the live records point at, plus every ancestor the validator walks. */
export function liveReferences(doc: Doc): Held {
  const intervals = new Map<number, [number, number][]>();
  const usage = emptyUsage();
  const items = new Set<Item>();
  const cover = (client: unknown, clock: unknown, length: unknown) => {
    if (
      typeof client === "number" &&
      typeof clock === "number" &&
      typeof length === "number"
    ) {
      const list = intervals.get(client) ?? [];
      list.push([clock, clock + length]);
      intervals.set(client, list);
    }
  };
  for (const [store, name] of migrationRoots(doc)) {
    let live = false;
    for (const latest of store._map.values()) {
      for (let entry: Item | null = latest; entry; entry = entry.left) {
        if (entry.deleted || !(entry.content instanceof ContentAny)) {
          continue;
        }
        live = true;
        countRecord(entry.content.arr[0], usage, cover);
      }
    }
    if (live) {
      const id = rootId(name);
      const found = getItem(doc.store, id);
      if (found instanceof Item) {
        items.add(found);
      }
    }
  }
  collect(doc, intervals, items);
  return { items, usage };
}
