import { generateKeyBetween as fractionalKeyBetween } from "fractional-indexing";
import { SaxesParser } from "saxes";
import {
  AbstractType as YAbstractType,
  applyUpdate as YapplyUpdate,
  Doc as YDoc,
  encodeStateAsUpdate as YencodeStateAsUpdate,
  Map as YMap,
  Text as YText,
  XmlFragment as YXmlFragment,
  type YEvent as YYEvent,
} from "yjs";

const idGrammar = /^[A-Za-z0-9_-]{1,80}$/;
const orderGrammar = /^[A-Za-z0-9]{2,128}$/;
const colorGrammar =
  /^(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{4}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|transparent)$/;
const lengthGrammar = /^(0|[1-9][0-9]{0,3})(\.[0-9]{1,2})?px$/;
const fontGrammar = /^[A-Za-z0-9 _-]{1,80}$/;
const weightGrammar = /^(normal|bold|[1-9]00)$/;
const opacityGrammar = /^(0(\.\d{1,2})?|1(\.0{1,2})?)$/;
const coordinateGrammar = /^-?\d{1,5}(\.\d{1,2})?$/;
const flowGrammar = /^(pinned|flow)$/;
const blobGrammar = /^\/files\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;
const dimensionGrammar = /^[1-9]\d{0,3}$/;
const buildOrderGrammar = /^[1-9]\d?$/;
const triggerGrammar = /^(click|withPrevious|afterPrevious)$/;
const transitionGrammar = /^(none|fade|push|magic)$/;
const durationGrammar = /^\d{1,5}$/;
const displayGrammar = /^(flex|grid)$/;
const directionGrammar = /^(row|column)$/;
const gapGrammar = /^(0|[1-9]\d{0,3})px$/;
const cellGrammar = /^(0|[1-9]\d*):(0|[1-9]\d*)$/;
export interface Node {
  attrs: Record<string, string>;
  children: (Node | string)[];
  tag: string;
}
/** The implementation must validate the shared L.2 schema and the deck's restricted text subset. */
export interface RichTextCodec {
  parse: (nodes: (Node | string)[], target: YXmlFragment) => void;
  serialize: (source: YXmlFragment) => (Node | string)[];
}
export type ElementType =
  | "text"
  | "shape"
  | "image"
  | "table"
  | "icon"
  | "connector"
  | "group";
export interface ElementData {
  cells?: Record<string, Node[]>;
  id: string;
  order: string;
  parent: string;
  props: Record<string, string>;
  style: Record<string, string>;
  text?: Node[];
  type: ElementType;
}
export interface SlideData {
  background: string;
  duration: string;
  elements: ElementData[];
  id: string;
  layout: Record<string, string>;
  notes: string;
  order: string;
  section?: string;
  transition: string;
}
export interface Observation {
  elementRevisions: Record<string, string>;
  revision: string;
  slide: SlideData;
}
export interface WriteResult {
  applied: string[];
  skipped: { id: string; reason: string }[];
}

const idPattern = idGrammar;
const orderPattern = orderGrammar;
export const LIMITS = {
  bytes: 2_000_000,
  cells: 4000,
  depth: 16,
  elements: 200,
  nodes: 20_000,
  slides: 500,
} as const;
export interface Theme {
  colors: Record<string, string>;
  fonts: Record<string, string>;
  sizes: Record<string, string>;
}
export interface Section {
  id: string;
  order: string;
  title: string;
}
export interface DeckOptions {
  maxObservations?: number;
  ownsBlob?: (path: string) => boolean;
}
const defaultTheme: Theme = { colors: {}, fonts: {}, sizes: {} };
function validateTheme(theme: Theme) {
  objectKeys(theme, ["colors", "fonts", "sizes"], "/meta/theme");
  for (const area of ["colors", "fonts", "sizes"] as const) {
    stringRecord(theme[area], `/meta/theme/${area}`);
  }
  for (const [area, values] of Object.entries(theme)) {
    if (!["colors", "fonts", "sizes"].includes(area)) {
      fail(`/meta/theme/${area}`, "unknown theme area");
    }
    if (Object.keys(values).length > 100) {
      fail(`/meta/theme/${area}`, "token limit");
    }
    for (const [key, value] of Object.entries(values)) {
      checkId(key, `/meta/theme/${area}/${key}`);
      validateStyle(
        { colors: "color", fonts: "font-family", sizes: "font-size" }[area] ??
          "",
        str(value),
        `/meta/theme/${area}/${key}`
      );
    }
  }
}
function validateNodes(
  nodes: (Node | string)[],
  path: string,
  depth = 0,
  count = { value: 0 }
) {
  if (!Array.isArray(nodes)) {
    fail(path, "expected text nodes");
  }
  if (depth > LIMITS.depth) {
    fail(path, "text depth limit");
  }
  for (const [index, node] of nodes.entries()) {
    count.value += 1;
    if (count.value > LIMITS.nodes) {
      fail(path, "text node limit");
    }
    if (typeof node === "string") {
      continue;
    }
    if (
      !node ||
      typeof node.tag !== "string" ||
      !node.attrs ||
      !Array.isArray(node.children)
    ) {
      fail(path, "invalid text node");
    }
    objectKeys(node, ["tag", "attrs", "children"], path);
    stringRecord(node.attrs, `${path}/attrs`);
    validateNodes(
      node.children,
      `${path}/${node.tag}[${index}]`,
      depth + 1,
      count
    );
  }
}
function validateText(nodes: Node[], codec: RichTextCodec, path: string) {
  validateNodes(nodes, path);
  const doc = new YDoc();
  try {
    const fragment = doc.getXmlFragment("text");
    codec.parse(structuredClone(nodes), fragment);
    const normalized = codec.serialize(fragment);
    validateNodes(normalized, path);
    if (canonical(normalized) !== canonical(nodes)) {
      fail(path, "non-canonical or lossy rich text");
    }
  } catch (error) {
    fail(path, `invalid rich text: ${String(error)}`);
  } finally {
    doc.destroy();
  }
}
const types = new Set([
  "text",
  "shape",
  "image",
  "table",
  "icon",
  "connector",
  "group",
]);
const propNames = new Set([
  "x",
  "y",
  "w",
  "h",
  "rotate",
  "flow",
  "src",
  "rows",
  "cols",
  "build-in",
  "build-out",
  "build-order",
  "build-trigger",
]);
const styles = new Set([
  "color",
  "background-color",
  "border-color",
  "border-width",
  "font-family",
  "font-size",
  "font-weight",
  "opacity",
]);
const effects = new Set([
  "fade",
  "rise",
  "drop",
  "left",
  "right",
  "scale",
  "pop",
]);
const escapeHtml = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;")
    .replaceAll(">", "&gt;");
function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`);
}
function checkId(value: string, path: string) {
  if (typeof value !== "string" || !idPattern.test(value)) {
    fail(path, "invalid id");
  }
}
function checkOrder(value: string, path: string) {
  if (typeof value !== "string" || !orderPattern.test(value)) {
    fail(path, "invalid order");
  }
  try {
    generateKeyBetween(value, null);
  } catch {
    fail(path, "invalid fractional order");
  }
}
function validateStyle(key: string, value: string, path: string) {
  if (!styles.has(key)) {
    fail(path, `unknown style ${key}`);
  }
  const color = colorGrammar;
  const length = lengthGrammar;
  let grammar = length;
  if (key.endsWith("color")) {
    grammar = color;
  }
  if (key === "font-family") {
    grammar = fontGrammar;
  }
  if (key === "font-weight") {
    grammar = weightGrammar;
  }
  if (key === "opacity") {
    grammar = opacityGrammar;
  }
  const valid = typeof value === "string" && grammar.test(value);
  if (!valid) {
    fail(path, `invalid style ${key}`);
  }
}
function validateProp(key: string, value: string, path: string) {
  if (!propNames.has(key)) {
    fail(path, `unknown property ${key}`);
  }
  let valid = false;
  if (["x", "y", "w", "h", "rotate"].includes(key)) {
    valid =
      coordinateGrammar.test(value) &&
      (!["w", "h"].includes(key) || Number(value) > 0);
  }
  if (key === "flow") {
    valid = flowGrammar.test(value);
  }
  if (key === "src") {
    valid = typeof value === "string" && blobGrammar.test(value);
  }
  if (key === "rows" || key === "cols") {
    valid = dimensionGrammar.test(value);
  }
  if (key === "build-in" || key === "build-out") {
    valid = effects.has(value);
  }
  if (key === "build-order") {
    valid = buildOrderGrammar.test(value) && Number(value) <= 50;
  }
  if (key === "build-trigger") {
    valid = triggerGrammar.test(value);
  }
  if (!valid) {
    fail(path, `invalid property ${key}`);
  }
}
function validateSlide(slide: SlideData) {
  objectKeys(
    slide,
    [
      "id",
      "order",
      "layout",
      "background",
      "transition",
      "duration",
      "notes",
      "elements",
      "section",
    ],
    "/slide"
  );
  for (const key of [
    "id",
    "order",
    "background",
    "transition",
    "duration",
    "notes",
  ] as const) {
    if (typeof slide[key] !== "string") {
      fail(`/slide/@${key}`, "expected string");
    }
  }
  stringRecord(slide.layout, "/slide/layout");
  if (!Array.isArray(slide.elements)) {
    fail("/slide/elements", "expected array");
  }
  if (new TextEncoder().encode(JSON.stringify(slide)).length > LIMITS.bytes) {
    fail("/slide", "size limit");
  }
  if (slide.section !== undefined) {
    checkId(slide.section, "/slide/@section");
  }
  const path = `/slide[@id='${slide.id}']`;
  checkId(slide.id, path);
  checkOrder(slide.order, path);
  if (
    !(
      transitionGrammar.test(slide.transition) &&
      durationGrammar.test(slide.duration)
    )
  ) {
    fail(path, "invalid transition");
  }
  validateStyle("background-color", slide.background, path);
  for (const [key, value] of Object.entries(slide.layout)) {
    if (
      !(
        (key === "display" && displayGrammar.test(value)) ||
        (key === "direction" && directionGrammar.test(value)) ||
        (key === "gap" && gapGrammar.test(value))
      )
    ) {
      fail(path, `invalid layout ${key}`);
    }
  }
  if (slide.elements.length > 200) {
    fail(path, "element limit exceeded");
  }
  if (new Set(slide.elements.map((e) => e.id)).size !== slide.elements.length) {
    fail(path, "duplicate element id");
  }
  for (const e of slide.elements) {
    validateElement(e, path, slide.id);
  }
  if (tableCells(slide) > LIMITS.cells) {
    fail(path, "table cell limit exceeded");
  }
  validateGroups(slide, path);
}
function validateElement(e: ElementData, path: string, slideId: string) {
  objectKeys(
    e,
    ["id", "type", "parent", "order", "props", "style", "text", "cells"],
    `${path}/element`
  );
  stringRecord(e.props, `${path}/element/props`);
  stringRecord(e.style, `${path}/element/style`);
  if (typeof e.parent !== "string") {
    fail(`${path}/element/parent`, "expected string");
  }
  if (e.text !== undefined && !Array.isArray(e.text)) {
    fail(`${path}/element/text`, "expected blocks");
  }
  if (e.cells !== undefined) {
    objectKeys(e.cells, Object.keys(e.cells), `${path}/element/cells`);
  }
  const p = `${path}/element[@id='${e.id}']`;
  checkId(e.id, p);
  checkOrder(e.order, p);
  if (e.id === slideId || !types.has(e.type)) {
    fail(p, "duplicate id or invalid type");
  }
  for (const [k, v] of Object.entries(e.props)) {
    validateProp(k, v, `${p}/@prop-${k}`);
  }
  for (const [k, v] of Object.entries(e.style)) {
    validateStyle(k, v, `${p}/@style-${k}`);
  }
  if (e.type !== "text" && e.text !== undefined) {
    fail(p, "text only allowed in text elements");
  }
  if (e.text) {
    validateNodes(e.text, `${p}/text`);
  }
  if (e.type === "table") {
    validateTable(e, p);
  } else if (e.cells !== undefined) {
    fail(p, "cells only allowed in tables");
  }
}
function validateTable(e: ElementData, p: string) {
  if (!(e.props.rows && e.props.cols)) {
    fail(p, "table dimensions required");
  }
  const rows = Number(e.props.rows),
    cols = Number(e.props.cols);

  for (const [key, nodes] of Object.entries(e.cells ?? {})) {
    if (!cellGrammar.test(key)) {
      fail(`${p}/cell/${key}`, "invalid cell key");
    }
    const [row, col] = key.split(":").map(Number);
    if (row === undefined || col === undefined || row >= rows || col >= cols) {
      fail(`${p}/cell/${key}`, "cell outside table");
    }
    validateNodes(nodes, `${p}/cell/${key}`);
  }
}
function tableCells(slide: SlideData) {
  return slide.elements.reduce(
    (sum, e) =>
      sum +
      (e.type === "table" ? Number(e.props.rows) * Number(e.props.cols) : 0),
    0
  );
}
function validateGroups(slide: SlideData, path: string) {
  for (const e of slide.elements) {
    if (e.parent === slide.id) {
      continue;
    }
    {
      const parent = slide.elements.find((item) => item.id === e.parent);
      if (parent?.type !== "group" || parent.id === e.id) {
        fail(path, `invalid parent for ${e.id}`);
      }
      const seen = new Set([e.id]);
      let current: ElementData | undefined = parent;
      while (current && current.parent !== slide.id) {
        if (seen.has(current.id)) {
          fail(path, "group cycle");
        }
        seen.add(current.id);
        if (seen.size > LIMITS.depth) {
          fail(path, "group depth limit");
        }
        current = slide.elements.find((item) => item.id === current?.parent);
      }
    }
  }
  for (const e of slide.elements.filter((item) => item.type === "group")) {
    if (
      slide.elements.filter(
        (item) => item.parent === e.id && item.props.flow !== "flow"
      ).length > 24
    ) {
      fail(path, "group pinned child limit exceeded");
    }
  }
}

function renderNode(n: Node | string): string {
  return typeof n === "string"
    ? escapeHtml(n)
    : `<${n.tag}${Object.entries(n.attrs)
        .sort()
        .map(([k, v]) => ` ${k}="${escapeHtml(v)}"`)
        .join("")}>${n.children.map(renderNode).join("")}</${n.tag}>`;
}
function parseXml(html: string): Node {
  if (new TextEncoder().encode(html).length > LIMITS.bytes) {
    fail("/slide", "HTML size limit");
  }
  const parser = new SaxesParser();
  let nodeCount = 0;
  const stack: Node[] = [];
  let root: Node | undefined;
  const path = () => `/${stack.map((n) => n.tag).join("/") || "slide"}`;
  parser.on("opentag", (tag) => {
    nodeCount += 1;
    if (nodeCount > LIMITS.nodes || stack.length > LIMITS.depth) {
      fail(path(), "HTML complexity limit");
    }
    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(tag.attributes)) {
      attrs[k] = String(v);
    }
    const node: Node = { attrs, children: [], tag: tag.name };
    if (stack.length) {
      stack.at(-1)?.children.push(node);
    } else if (root) {
      fail(path(), "multiple roots");
    } else {
      root = node;
    }
    stack.push(node);
  });
  parser.on("text", (s) => {
    if (stack.length) {
      stack.at(-1)?.children.push(s);
    } else if (s.trim()) {
      fail(path(), "text outside root");
    }
  });
  parser.on("closetag", () => {
    stack.pop();
  });
  parser.on("cdata", () => fail(path(), "CDATA is forbidden"));
  parser.on("comment", () => fail(path(), "comments are forbidden"));
  parser.on("doctype", () => fail(path(), "doctype is forbidden"));
  parser.on("processinginstruction", () =>
    fail(path(), "processing instructions are forbidden")
  );
  parser.on("error", (error) => fail(path(), error.message));
  parser.write(html).close();
  if (!root) {
    fail("/slide", "missing root");
  }
  return root;
}
function checkAttrs(node: Node, allowed: string[], path: string) {
  for (const k of Object.keys(node.attrs)) {
    if (!allowed.includes(k)) {
      fail(path, `unknown attribute ${k}`);
    }
  }
}
function required(node: Node, key: string, path: string): string {
  const value = node.attrs[key];
  if (value === undefined) {
    fail(path, `missing ${key}`);
  }
  return value;
}
function parseBlocks(
  children: (Node | string)[],
  codec: RichTextCodec,
  path: string
): Node[] {
  const nodes = children.map((node) => {
    if (typeof node === "string") {
      fail(path, "expected block node");
    }
    return node;
  });
  validateText(nodes, codec, path);
  return nodes;
}
function parseCells(
  child: Node,
  codec: RichTextCodec,
  p: string
): Record<string, Node[]> {
  const cells: Record<string, Node[]> = {};
  for (const cell of child.children) {
    if (typeof cell === "string" && !cell.trim()) {
      continue;
    }
    if (typeof cell === "string" || cell.tag !== "cell") {
      fail(p, "expected cell");
    }
    checkAttrs(cell, ["key"], `${p}/cell`);
    const key = required(cell, "key", `${p}/cell`);
    if (Object.hasOwn(cells, key)) {
      fail(`${p}/cell/${key}`, "duplicate cell");
    }
    const nodes = cell.children.map((n) => {
      if (typeof n === "string") {
        fail(`${p}/cell/${key}`, "expected block");
      }
      return n;
    });
    validateText(nodes, codec, `${p}/cell/${key}`);
    cells[key] = nodes;
  }
  return cells;
}
function parseElement(
  child: Node,
  codec: RichTextCodec,
  p: string
): ElementData {
  checkAttrs(
    child,
    [
      "id",
      "type",
      "parent",
      "order",
      ...[...propNames].map((k) => `prop-${k}`),
      ...[...styles].map((k) => `style-${k}`),
    ],
    p
  );
  const e: ElementData = {
    id: required(child, "id", p),
    order: required(child, "order", p),
    parent: required(child, "parent", p),
    props: {},
    style: {},
    type: required(child, "type", p) as ElementType,
  };
  for (const [k, v] of Object.entries(child.attrs)) {
    if (k.startsWith("prop-")) {
      e.props[k.slice(5)] = v;
    }
    if (k.startsWith("style-")) {
      e.style[k.slice(6)] = v;
    }
  }
  if (e.type === "text") {
    e.text = parseBlocks(child.children, codec, p);
  } else if (e.type === "table") {
    e.cells = parseCells(child, codec, p);
  } else if (child.children.some((n) => typeof n !== "string" || n.trim())) {
    fail(p, "unexpected content");
  }
  return e;
}
export function parseSlide(html: string, codec: RichTextCodec): SlideData {
  const root = parseXml(html);
  const path = "/slide";
  if (root.tag !== "slide") {
    fail(path, "expected slide");
  }
  checkAttrs(
    root,
    [
      "id",
      "order",
      "background",
      "transition",
      "duration",
      "layout-display",
      "layout-direction",
      "layout-gap",
      "section",
    ],
    path
  );
  const slide: SlideData = {
    background: required(root, "background", path),
    duration: required(root, "duration", path),
    elements: [],
    id: required(root, "id", path),
    layout: {},
    notes: "",
    order: required(root, "order", path),
    transition: required(root, "transition", path),
  };
  for (const [k, v] of Object.entries(root.attrs)) {
    if (k.startsWith("layout-")) {
      slide.layout[k.slice(7)] = v;
    }
  }
  if (Object.hasOwn(root.attrs, "section")) {
    slide.section = root.attrs.section;
  }
  let notes = false;
  for (const child of root.children) {
    if (typeof child === "string") {
      if (child.trim()) {
        fail(path, "unexpected text");
      }
      continue;
    }
    const p = nodePath(path, child);
    if (child.tag === "notes") {
      checkAttrs(child, [], p);
      if (notes || child.children.some((n) => typeof n !== "string")) {
        fail(p, "invalid notes");
      }
      notes = true;
      slide.notes = child.children.join("");
      continue;
    }
    if (child.tag !== "element") {
      fail(p, "unknown element");
    }
    slide.elements.push(parseElement(child, codec, p));
  }
  validateSlide(slide);
  return slide;
}
export function serializeSlide(slide: SlideData, codec: RichTextCodec): string {
  validateSlide(slide);
  for (const element of slide.elements) {
    if (element.text) {
      validateText(element.text, codec, `/slide/element/${element.id}/text`);
    }
    for (const [key, nodes] of Object.entries(element.cells ?? {})) {
      validateText(nodes, codec, `/slide/element/${element.id}/cell/${key}`);
    }
  }
  const root: Node = {
    attrs: {
      ...(slide.section === undefined ? {} : { section: slide.section }),
      background: slide.background,
      duration: slide.duration,
      id: slide.id,
      order: slide.order,
      transition: slide.transition,
      ...Object.fromEntries(
        Object.entries(slide.layout).map(([k, v]) => [`layout-${k}`, v])
      ),
    },
    children: [
      { attrs: {}, children: [slide.notes], tag: "notes" },
      ...slide.elements.map(
        (e): Node => ({
          attrs: {
            id: e.id,
            order: e.order,
            parent: e.parent,
            type: e.type,
            ...Object.fromEntries(
              Object.entries(e.props).map(([k, v]) => [`prop-${k}`, v])
            ),
            ...Object.fromEntries(
              Object.entries(e.style).map(([k, v]) => [`style-${k}`, v])
            ),
          },
          children:
            e.type === "table"
              ? Object.entries(e.cells ?? {})
                  .sort()
                  .map(([key, nodes]) => ({
                    attrs: { key },
                    children: nodes,
                    tag: "cell",
                  }))
              : (e.text ?? []),
          tag: "element",
        })
      ),
    ],
    tag: "slide",
  };
  return renderNode(root);
}
type SharedMap = YMap<unknown>;
const map = (value: unknown): SharedMap => {
  if (!(value instanceof YMap) || value._start !== null) {
    fail("/scene", "invalid scene map");
  }
  return value;
};
const str = (value: unknown): string => {
  if (typeof value !== "string") {
    fail("/scene", "invalid scene value");
  }
  return value;
};
const entries = (value: unknown): Record<string, string> =>
  Object.fromEntries([...map(value).entries()].map(([k, v]) => [k, str(v)]));
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b))
        )
      : v
  );
function setKeys(target: SharedMap, values: Record<string, string>) {
  for (const key of target.keys()) {
    if (!Object.hasOwn(values, key)) {
      target.delete(key);
    }
  }
  for (const [k, v] of Object.entries(values)) {
    if (target.get(k) !== v) {
      target.set(k, v);
    }
  }
}
const keys = (value: SharedMap, allowed: string[], path: string) => {
  for (const key of value.keys()) {
    if (!allowed.includes(key)) {
      fail(`${path}/${key}`, "unknown key");
    }
  }
};
export class Deck {
  readonly doc: YDoc;
  readonly codec: RichTextCodec;
  private readonly options: DeckOptions;
  private readonly history = new Map<string, number>();
  private readonly observations = new Map<
    string,
    { observation: Observation; history: Map<string, number> }
  >();
  private readonly changed = (events: YYEvent<YAbstractType<unknown>>[]) => {
    for (const event of events) {
      const [sid, area, eid] = event.path;
      if (typeof sid !== "string") {
        for (const key of event.changes.keys.keys()) {
          this.bump(`${key}:root`);
        }
        continue;
      }
      if (area === "elements") {
        if (typeof eid === "string") {
          this.bump(`${sid}:element:${eid}`);
        } else {
          for (const key of event.changes.keys.keys()) {
            this.bump(`${sid}:element:${key}`);
          }
        }
      } else if (area) {
        this.bump(`${sid}:${area}`);
      } else {
        for (const key of event.changes.keys.keys()) {
          this.bump(`${sid}:${key}`);
        }
      }
    }
  };
  private bump(key: string) {
    if (this.history.size > 120_000) {
      this.history.clear();
      this.observations.clear();
    }
    this.history.set(key, (this.history.get(key) ?? 0) + 1);
  }
  constructor(doc: YDoc, codec: RichTextCodec, options: DeckOptions = {}) {
    this.doc = doc;
    this.codec = codec;
    if (
      options.maxObservations !== undefined &&
      (!Number.isInteger(options.maxObservations) ||
        options.maxObservations < 1 ||
        options.maxObservations > 128)
    ) {
      fail("/options/maxObservations", "expected integer 1..128");
    }
    this.options = { ...options };
    this.slides.observeDeep(this.changed);
  }
  destroy() {
    this.slides.unobserveDeep(this.changed);
    this.observations.clear();
  }
  private get slides(): SharedMap {
    return this.doc.getMap("slides");
  }
  ids(): string[] {
    return [...this.slides.keys()].sort((a, b) => {
      const aa = str(map(this.slides.get(a)).get("order"));
      const bb = str(map(this.slides.get(b)).get("order"));
      return compareOrder(aa, bb) || compareOrder(a, b);
    });
  }
  addSlide(slide: SlideData): void {
    this.validateContent(slide);
    if (this.slides.size >= 500 || this.slides.has(slide.id)) {
      throw new Error("slide limit or duplicate id");
    }
    this.doc.transact(() => {
      const s = new YMap<unknown>();
      s.set("elements", new YMap());
      s.set("layout", new YMap());
      s.set("notes", new YText());
      this.slides.set(slide.id, s);
      this.applySlide(s, slide);
    });
  }
  setElementKey(
    slideId: string,
    elementId: string,
    area: "props" | "style",
    key: string,
    value: string
  ): void {
    const snapshot = this.snapshot(slideId);
    const element = snapshot.elements.find((item) => item.id === elementId);
    if (!element) {
      throw new Error("element missing");
    }
    element[area][key] = value;
    this.validateContent(snapshot);
    map(
      map(
        map(map(this.slides.get(slideId)).get("elements")).get(elementId)
      ).get(area)
    ).set(key, value);
  }
  moveSlide(id: string, before: string | null, after: string | null): void {
    const slide = map(this.slides.get(id));
    if (id === before || id === after) {
      throw new Error("cannot order against itself");
    }
    const left =
      before === null ? null : str(map(this.slides.get(before)).get("order"));
    const right =
      after === null ? null : str(map(this.slides.get(after)).get("order"));
    slide.set("order", generateKeyBetween(left, right));
  }
  private snapshot(id: string): SlideData {
    const s = map(this.slides.get(id));
    const notes = s.get("notes");
    if (!(notes instanceof YText)) {
      throw new Error("invalid notes");
    }
    const elements: ElementData[] = [...map(s.get("elements")).entries()]
      .map(([eid, raw]) => {
        const e = map(raw);
        const type = str(e.get("type")) as ElementType;
        const result: ElementData = {
          id: eid,
          order: str(e.get("order")),
          parent: str(e.get("parent")),
          props: entries(e.get("props")),
          style: entries(e.get("style")),
          type,
        };
        if (type === "text") {
          const fragment = e.get("text");
          if (!(fragment instanceof YXmlFragment)) {
            throw new Error("invalid text");
          }
          result.text = this.codec.serialize(fragment).map((n) => {
            if (typeof n === "string") {
              throw new Error("invalid text block");
            }
            return n;
          });
        }
        if (type === "table") {
          result.cells = {};
          for (const [key, fragment] of map(e.get("cells"))) {
            if (!(fragment instanceof YXmlFragment)) {
              fail(
                `/slide/${id}/element/${eid}/cell/${key}`,
                "invalid fragment"
              );
            }
            result.cells[key] = this.codec.serialize(fragment).map((node) => {
              if (typeof node === "string") {
                fail("/cell", "expected block");
              }
              return node;
            });
          }
        }
        return result;
      })
      .sort((a, b) => a.id.localeCompare(b.id));
    const slide: SlideData = {
      background: str(s.get("background")),
      duration: str(s.get("duration")),
      elements,
      id,
      layout: entries(s.get("layout")),
      notes: notes.toString(),
      order: str(s.get("order")),
      transition: str(s.get("transition")),
    };
    if (s.has("section")) {
      slide.section = str(s.get("section"));
    }
    this.validateContent(slide);
    return slide;
  }
  read(id: string): Observation {
    const slide = this.snapshot(id);
    for (const retained of this.observations.values()) {
      if (
        canonical(retained.observation.slide) === canonical(slide) &&
        this.sameHistory(retained.history, id)
      ) {
        return structuredClone(retained.observation);
      }
    }
    const observation: Observation = {
      elementRevisions: Object.fromEntries(
        slide.elements.map((element) => [element.id, crypto.randomUUID()])
      ),
      revision: crypto.randomUUID(),
      slide,
    };
    this.observations.set(observation.revision, {
      history: new Map(this.history),
      observation: structuredClone(observation),
    });
    while (
      this.observations.size > (this.options.maxObservations ?? 64) ||
      this.observationBytes() > LIMITS.bytes * 2
    ) {
      const first = this.observations.keys().next().value;
      if (first) {
        this.observations.delete(first);
      }
    }
    return observation;
  }
  private observationBytes() {
    return [...this.observations.values()].reduce(
      (sum, retained) =>
        sum +
        new TextEncoder().encode(canonical(retained.observation)).byteLength,
      0
    );
  }
  private sameHistory(history: Map<string, number>, id: string) {
    return [...new Set([...history.keys(), ...this.history.keys()])]
      .filter((key) => key.startsWith(`${id}:`))
      .every((key) => history.get(key) === this.history.get(key));
  }
  private validateContent(slide: SlideData) {
    validateSlide(slide);
    const others = [...this.slides].filter(([id]) => id !== slide.id);
    const cells = others.reduce(
      (sum, [, raw]) =>
        sum +
        [...map(map(raw).get("elements")).values()].reduce<number>(
          (total, value) => {
            const element = map(value);
            if (element.get("type") !== "table") {
              return total;
            }
            const props = entries(element.get("props"));
            return total + Number(props.rows) * Number(props.cols);
          },
          0
        ),
      tableCells(slide)
    );
    if (cells > LIMITS.cells) {
      fail("/slides", "deck table cell limit");
    }
    const theme = this.theme();
    for (const e of slide.elements) {
      const path = `/slide/${slide.id}/element/${e.id}`;
      if (e.props.src && !this.options.ownsBlob?.(e.props.src)) {
        fail(`${path}/@prop-src`, "blob does not belong to artifact");
      }
      if (
        e.style["font-family"] &&
        !Object.values(theme.fonts).includes(e.style["font-family"])
      ) {
        fail(`${path}/@style-font-family`, "font outside theme");
      }
      if (e.text) {
        validateText(e.text, this.codec, `${path}/text`);
      }
      for (const [key, nodes] of Object.entries(e.cells ?? {})) {
        validateText(nodes, this.codec, `${path}/cell/${key}`);
      }
    }
    if (slide.section && !this.doc.getMap("sections").has(slide.section)) {
      fail(`/slide/${slide.id}/@section`, "unknown section");
    }
  }
  private applyCells(target: SharedMap, e: ElementData) {
    let raw = target.get("cells");
    if (!(raw instanceof YMap)) {
      raw = new YMap();
      target.set("cells", raw);
    }
    const cells = map(raw);
    for (const key of cells.keys()) {
      if (!Object.hasOwn(e.cells ?? {}, key)) {
        cells.delete(key);
      }
    }
    for (const [key, nodes] of Object.entries(e.cells ?? {})) {
      let fragment = cells.get(key);
      if (!(fragment instanceof YXmlFragment)) {
        fragment = new YXmlFragment();
        cells.set(key, fragment);
      }
      const xml = fragment as YXmlFragment;
      if (canonical(this.codec.serialize(xml)) !== canonical(nodes)) {
        xml.delete(0, xml.length);
        this.codec.parse(nodes, xml);
      }
    }
  }
  private applyElement(target: SharedMap, e: ElementData) {
    for (const key of ["type", "parent", "order"] as const) {
      if (target.get(key) !== e[key]) {
        target.set(key, e[key]);
      }
    }
    setKeys(map(target.get("props")), e.props);
    setKeys(map(target.get("style")), e.style);
    if (e.type === "table") {
      this.applyCells(target, e);
    } else {
      target.delete("cells");
    }
    if (e.type !== "text") {
      target.delete("text");
    }
    if (e.type === "text") {
      let fragment = target.get("text");
      if (!(fragment instanceof YXmlFragment)) {
        fragment = new YXmlFragment();
        target.set("text", fragment);
      }
      const xml = fragment as YXmlFragment;
      if (canonical(this.codec.serialize(xml)) !== canonical(e.text ?? [])) {
        xml.delete(0, xml.length);
        this.codec.parse(e.text ?? [], xml);
      }
    }
  }
  private applySlide(target: SharedMap, slide: SlideData) {
    if (slide.section === undefined) {
      target.delete("section");
    } else if (target.get("section") !== slide.section) {
      target.set("section", slide.section);
    }
    for (const key of [
      "order",
      "background",
      "transition",
      "duration",
    ] as const) {
      if (target.get(key) !== slide[key]) {
        target.set(key, slide[key]);
      }
    }
    setKeys(map(target.get("layout")), slide.layout);
    const notes = target.get("notes");
    if (!(notes instanceof YText)) {
      throw new Error("invalid notes");
    }
    if (notes.toString() !== slide.notes) {
      notes.delete(0, notes.length);
      notes.insert(0, slide.notes);
    }
    const elements = map(target.get("elements"));
    for (const e of slide.elements) {
      let entry = elements.get(e.id);
      if (!(entry instanceof YMap)) {
        entry = new YMap();
        (entry as SharedMap).set("props", new YMap());
        (entry as SharedMap).set("style", new YMap());
        elements.set(e.id, entry);
      }
      this.applyElement(map(entry), e);
    }
  }
  theme(): Theme {
    const meta = this.doc.getMap("meta");
    const raw = meta.get("theme");
    if (raw === undefined) {
      return structuredClone(defaultTheme);
    }
    const theme = map(raw);
    const result = {
      colors: entries(theme.get("colors")),
      fonts: entries(theme.get("fonts")),
      sizes: entries(theme.get("sizes")),
    };
    validateTheme(result);
    return result;
  }
  setTheme(theme: Theme): void {
    validateTheme(theme);
    this.mutateCandidate((candidate) => candidate.applyTheme(theme));
    this.applyTheme(theme);
  }
  private applyTheme(theme: Theme) {
    this.doc.transact(() => {
      const meta = this.doc.getMap("meta");
      let raw = meta.get("theme");
      if (!(raw instanceof YMap)) {
        raw = new YMap();
        for (const key of ["colors", "fonts", "sizes"]) {
          map(raw).set(key, new YMap());
        }
        meta.set("theme", raw);
      }
      for (const key of ["colors", "fonts", "sizes"] as const) {
        setKeys(map(map(raw).get(key)), theme[key]);
      }
    });
  }
  setTitle(title: string) {
    if (typeof title !== "string" || title.length > 500) {
      fail("/meta/title", "invalid title");
    }
    this.doc.getMap("meta").set("title", title);
  }
  sections(): Section[] {
    return [...this.doc.getMap("sections")]
      .map(([id, value]) => {
        const entry = map(value);
        return {
          id,
          order: str(entry.get("order")),
          title: str(entry.get("title")),
        };
      })
      .sort(
        (a, b) => a.order.localeCompare(b.order) || a.id.localeCompare(b.id)
      );
  }
  setSection(section: Section) {
    checkId(section.id, "/sections/@id");
    checkOrder(section.order, "/sections/@order");
    if (typeof section.title !== "string" || section.title.length > 500) {
      fail("/sections/title", "invalid title");
    }
    const sections = this.doc.getMap("sections");
    if (!sections.has(section.id) && sections.size >= LIMITS.slides) {
      fail("/sections", "section limit");
    }
    this.doc.transact(() => {
      let entry = sections.get(section.id);
      if (!(entry instanceof YMap)) {
        entry = new YMap();
        sections.set(section.id, entry);
      }
      setKeys(map(entry), { order: section.order, title: section.title });
    });
  }
  deleteSection(id: string) {
    this.doc.transact(() => {
      for (const raw of this.slides.values()) {
        const slide = map(raw);
        if (slide.get("section") === id) {
          slide.delete("section");
        }
      }
      this.doc.getMap("sections").delete(id);
    });
  }
  deleteSlide(id: string) {
    this.slides.delete(id);
  }
  duplicateSlide(
    id: string,
    newId: string,
    order: string,
    elementIds: Record<string, string>
  ) {
    const slide = this.snapshot(id);
    const ids = slide.elements.map((element) => elementIds[element.id]);
    if (
      ids.some((value) => !value) ||
      new Set(ids).size !== ids.length ||
      ids.includes(newId)
    ) {
      fail("/slide", "provide unique new element ids");
    }
    slide.id = newId;
    slide.order = order;
    for (const element of slide.elements) {
      element.parent =
        element.parent === id ? newId : (elementIds[element.parent] ?? "");
      element.id = elementIds[element.id] ?? "";
    }
    this.addSlide(slide);
  }
  updateSlide(id: string, patch: Partial<Omit<SlideData, "id" | "elements">>) {
    const slide = { ...this.snapshot(id), ...structuredClone(patch), id };
    this.validateContent(slide);
    this.doc.transact(() => this.applySlide(map(this.slides.get(id)), slide));
  }
  addElement(slideId: string, element: ElementData) {
    const slide = this.snapshot(slideId);
    if (slide.elements.some((entry) => entry.id === element.id)) {
      fail("/slide/element", "duplicate id");
    }
    slide.elements.push(structuredClone(element));
    this.commitSlide(slide);
  }
  updateElement(
    slideId: string,
    elementId: string,
    patch: Partial<Omit<ElementData, "id">>
  ) {
    const slide = this.snapshot(slideId);
    const index = slide.elements.findIndex((entry) => entry.id === elementId);
    if (index < 0) {
      fail("/slide/element", "missing element");
    }
    const current = slide.elements[index];
    if (!current) {
      fail("/slide/element", "missing element");
    }
    slide.elements[index] = {
      ...current,
      ...structuredClone(patch),
      id: elementId,
    };
    this.commitSlide(slide);
  }
  deleteElement(slideId: string, elementId: string) {
    const slide = this.snapshot(slideId);
    const deleted = new Set([elementId]);
    for (let i = 0; i < LIMITS.depth + 1; i += 1) {
      for (const element of slide.elements) {
        if (deleted.has(element.parent)) {
          deleted.add(element.id);
        }
      }
    }
    slide.elements = slide.elements.filter(
      (element) => !deleted.has(element.id)
    );
    this.commitSlide(slide);
  }
  moveElement(
    slideId: string,
    id: string,
    parent: string,
    before: string | null,
    after: string | null
  ) {
    const slide = this.snapshot(slideId);
    const key = (neighbor: string | null) => {
      if (neighbor === null) {
        return null;
      }
      const element = slide.elements.find((entry) => entry.id === neighbor);
      if (!element || element.parent !== parent || element.id === id) {
        fail("/slide/element/order", "invalid neighbor");
      }
      return element.order;
    };
    this.updateElement(slideId, id, {
      order: generateKeyBetween(key(before), key(after)),
      parent,
    });
  }
  groupElements(slideId: string, group: ElementData, ids: string[]) {
    if (
      group.type !== "group" ||
      !ids.length ||
      new Set(ids).size !== ids.length
    ) {
      fail("/slide/group", "invalid group selection");
    }
    const slide = this.snapshot(slideId);
    if (slide.elements.some((entry) => entry.id === group.id)) {
      fail("/slide/group", "duplicate group");
    }
    for (const id of ids) {
      const element = slide.elements.find((entry) => entry.id === id);
      if (!element || element.parent !== group.parent) {
        fail("/slide/group", "selection must share parent");
      }
      element.parent = group.id;
    }
    slide.elements.push(structuredClone(group));
    this.commitSlide(slide);
  }
  ungroupElements(slideId: string, id: string) {
    const slide = this.snapshot(slideId);
    const group = slide.elements.find((entry) => entry.id === id);
    if (group?.type !== "group") {
      fail("/slide/group", "missing group");
    }
    for (const element of slide.elements) {
      if (element.parent === id) {
        element.parent = group.parent;
      }
    }
    slide.elements = slide.elements.filter((entry) => entry.id !== id);
    this.commitSlide(slide);
  }
  textFragment(slideId: string, elementId: string): YXmlFragment {
    const raw = map(
      map(map(this.slides.get(slideId)).get("elements")).get(elementId)
    );
    const fragment = raw.get("text");
    if (raw.get("type") !== "text" || !(fragment instanceof YXmlFragment)) {
      fail("/slide/element/text", "missing text");
    }
    return fragment;
  }
  cellFragment(slideId: string, elementId: string, key: string): YXmlFragment {
    const element = this.snapshot(slideId).elements.find(
      (entry) => entry.id === elementId
    );
    if (element?.type !== "table") {
      fail("/slide/table", "missing table");
    }
    if (!Object.hasOwn(element.cells ?? {}, key)) {
      this.setCell(slideId, elementId, key, []);
    }
    const raw = map(
      map(map(this.slides.get(slideId)).get("elements")).get(elementId)
    );
    const fragment = map(raw.get("cells")).get(key);
    if (!(fragment instanceof YXmlFragment)) {
      fail("/slide/table/cell", "missing fragment");
    }
    return fragment;
  }
  duplicateElement(slideId: string, id: string, newId: string, order: string) {
    const element = this.snapshot(slideId).elements.find(
      (entry) => entry.id === id
    );
    if (!element || element.type === "group") {
      fail("/slide/element", "duplicate a non-group element");
    }
    this.addElement(slideId, { ...element, id: newId, order });
  }
  updateElements(
    slideId: string,
    patches: Record<string, Partial<Omit<ElementData, "id">>>
  ) {
    const slide = this.snapshot(slideId);
    for (const [id, patch] of Object.entries(patches)) {
      const index = slide.elements.findIndex((entry) => entry.id === id);
      const element = slide.elements[index];
      if (!element) {
        fail(`/slide/element/${id}`, "missing element");
      }
      slide.elements[index] = { ...element, ...structuredClone(patch), id };
    }
    this.commitSlide(slide);
  }
  setCell(slideId: string, id: string, key: string, nodes: Node[]) {
    const element = this.snapshot(slideId).elements.find(
      (entry) => entry.id === id
    );
    if (element?.type !== "table") {
      fail("/slide/table", "missing table");
    }
    this.updateElement(slideId, id, {
      cells: { ...element.cells, [key]: structuredClone(nodes) },
    });
  }
  private commitSlide(slide: SlideData) {
    this.validateContent(slide);
    this.doc.transact(() => {
      const target = map(this.slides.get(slide.id));
      const elements = map(target.get("elements"));
      const ids = new Set(slide.elements.map((entry) => entry.id));
      for (const key of elements.keys()) {
        if (!ids.has(key)) {
          elements.delete(key);
        }
      }
      this.applySlide(target, slide);
    });
  }
  private mutateCandidate(change: (candidate: Deck) => void) {
    const doc = new YDoc({ gc: false });
    YapplyUpdate(doc, YencodeStateAsUpdate(this.doc));
    const candidate = new Deck(doc, this.codec, this.options);
    try {
      change(candidate);
      candidate.validate();
    } finally {
      candidate.destroy();
      doc.destroy();
    }
  }
  /** Authenticate/authorize and rate-limit before this synchronous boundary. Never apply network updates directly. */
  applyUpdate(update: Uint8Array) {
    if (update.byteLength > LIMITS.bytes) {
      fail("/update", "update size limit");
    }
    this.mutateCandidate((candidate) => {
      YapplyUpdate(candidate.doc, update);
      if (candidate.doc.store.pendingStructs || candidate.doc.store.pendingDs) {
        fail("/update", "missing dependencies; resynchronize and retry");
      }
    });
    // Apply the original structs, preserving client IDs, clocks and delete sets. No snapshot re-encoding.
    YapplyUpdate(this.doc, update);
  }
  /** Checkpoint replacement is a new authoritative transaction, not a merge of an old checkpoint. */
  restore(update: Uint8Array) {
    if (update.byteLength > LIMITS.bytes) {
      fail("/restore", "checkpoint size limit");
    }
    const doc = new YDoc({ gc: false });
    const candidate = new Deck(doc, this.codec, this.options);
    try {
      YapplyUpdate(doc, update);
      if (doc.store.pendingStructs || doc.store.pendingDs) {
        fail("/restore", "incomplete checkpoint");
      }
      candidate.validate();
      this.doc.transact(() => {
        for (const name of ["meta", "sections", "slides"]) {
          const target = this.doc.getMap(name);
          target.clear();
          for (const [key, value] of doc.getMap(name)) {
            target.set(
              key,
              value instanceof YAbstractType ? value.clone() : value
            );
          }
        }
      });
      this.observations.clear();
    } finally {
      candidate.destroy();
      doc.destroy();
    }
  }
  private validateMetaSections() {
    const meta = this.doc.getMap("meta");
    keys(meta, ["title", "theme"], "/meta");
    if (
      meta.has("title") &&
      (typeof meta.get("title") !== "string" ||
        str(meta.get("title")).length > 500)
    ) {
      fail("/meta/title", "invalid title");
    }
    if (meta.has("theme")) {
      keys(map(meta.get("theme")), ["colors", "fonts", "sizes"], "/meta/theme");
    }
    this.theme();
    const sections = this.doc.getMap("sections");
    if (sections.size > LIMITS.slides) {
      fail("/sections", "section limit");
    }
    for (const section of this.sections()) {
      checkId(section.id, "/sections/id");
      checkOrder(section.order, "/sections/order");
      if (section.title.length > 500) {
        fail("/sections/title", "title size");
      }
      keys(
        map(sections.get(section.id)),
        ["title", "order"],
        `/sections/${section.id}`
      );
    }
  }
  validate() {
    for (const [name, value] of this.doc.share) {
      if (!["meta", "sections", "slides"].includes(name)) {
        fail(`/${name}`, "unknown root");
      }
      // getMap materializes roots decoded by Yjs as AbstractType.
      this.doc.getMap(name);
      if (value._start !== null) {
        fail(`/${name}`, "invalid root");
      }
    }
    this.validateMetaSections();
    if (this.slides.size > LIMITS.slides) {
      fail("/slides", "slide limit");
    }
    let totalCells = 0;
    for (const id of this.slides.keys()) {
      const raw = map(this.slides.get(id));
      keys(
        raw,
        [
          "order",
          "background",
          "transition",
          "duration",
          "notes",
          "elements",
          "layout",
          "section",
        ],
        `/slide/${id}`
      );
      for (const [eid, value] of map(raw.get("elements"))) {
        const element = map(value);
        keys(
          element,
          ["type", "parent", "order", "props", "style", "text", "cells"],
          `/slide/${id}/element/${eid}`
        );
        if (element.get("type") !== "text" && element.has("text")) {
          fail(`/slide/${id}/element/${eid}/text`, "unexpected fragment");
        }
        if (element.get("type") !== "table" && element.has("cells")) {
          fail(`/slide/${id}/element/${eid}/cells`, "unexpected cells");
        }
      }
      const slide = this.snapshot(id);
      totalCells += slide.elements.reduce(
        (sum, e) =>
          sum +
          (e.type === "table"
            ? Number(e.props.rows) * Number(e.props.cols)
            : 0),
        0
      );
    }
    if (totalCells > LIMITS.cells) {
      fail("/slides", "deck table cell limit");
    }
    if (YencodeStateAsUpdate(this.doc).byteLength > LIMITS.bytes * 8) {
      fail("/deck", "encoded scene size limit; compact checkpoint required");
    }
  }
  write(id: string, html: string, observed: Observation): WriteResult {
    const desired = parseSlide(html, this.codec);
    const retained = this.observations.get(observed.revision);
    if (
      !retained ||
      canonical(retained.observation) !== canonical(observed) ||
      id !== desired.id ||
      id !== observed.slide.id
    ) {
      throw new Error("invalid or expired observation");
    }
    const unchanged = (key: string) =>
      retained.history.get(`${id}:${key}`) ===
        this.history.get(`${id}:${key}`) &&
      retained.history.get(`${id}:root`) === this.history.get(`${id}:root`);
    const current = this.read(id);
    const target = map(this.slides.get(id));
    const result: WriteResult = { applied: [], skipped: [] };
    // Check the final merged scene before mutating. Human-modified elements always win.
    const old = new Map(observed.slide.elements.map((e) => [e.id, e]));
    const now = new Map(current.slide.elements.map((e) => [e.id, e]));
    const wanted = new Map(desired.elements.map((e) => [e.id, e]));
    const merged = new Map(now);
    for (const eid of new Set([...old.keys(), ...wanted.keys()])) {
      const a = old.get(eid),
        b = wanted.get(eid),
        c = now.get(eid);
      if (canonical(a) === canonical(b)) {
        continue;
      }
      if (!unchanged(`element:${eid}`) || canonical(a) !== canonical(c)) {
        result.skipped.push({ id: eid, reason: "changed since read" });
        continue;
      }
      if (b) {
        merged.set(eid, b);
      } else {
        merged.delete(eid);
      }
      result.applied.push(eid);
    }
    const slideKeys = [
      "order",
      "background",
      "transition",
      "duration",
      "layout",
      "notes",
      "section",
    ] as const;
    const final = { ...current.slide, elements: [...merged.values()] };
    for (const key of slideKeys) {
      if (canonical(observed.slide[key]) === canonical(desired[key])) {
        continue;
      }
      if (
        !unchanged(key) ||
        canonical(observed.slide[key]) !== canonical(current.slide[key])
      ) {
        result.skipped.push({ id, reason: `${key} changed since read` });
        continue;
      }
      Object.assign(final, { [key]: desired[key] });
      result.applied.push(`${id}:${key}`);
    }
    this.validateContent(final);
    this.doc.transact(() => {
      const elements = map(target.get("elements"));
      for (const eid of elements.keys()) {
        if (!merged.has(eid)) {
          elements.delete(eid);
        }
      }
      this.applySlide(target, final);
    });
    return result;
  }
}
export function generateKeyBetween(
  left: string | null,
  right: string | null
): string {
  return fractionalKeyBetween(left, right);
}

function compareOrder(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

function objectKeys(value: unknown, allowed: string[], path: string): void {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    fail(path, "expected plain object");
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail(`${path}/${key}`, "unknown key");
    }
  }
}
function stringRecord(
  value: unknown,
  path: string
): asserts value is Record<string, string> {
  if (!value || typeof value !== "object") {
    fail(path, "expected string record");
  }
  objectKeys(value, Object.keys(value), path);
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      fail(`${path}/${key}`, "expected string");
    }
  }
}

function nodePath(path: string, node: Node) {
  const suffix = node.attrs.id ? `[@id='${node.attrs.id}']` : "";
  return `${path}/${node.tag}${suffix}`;
}
