import { generateKeyBetween } from "fractional-indexing";
import { SaxesParser } from "saxes";
import * as Y from "yjs";

export type Node = {
  tag: string;
  attrs: Record<string, string>;
  children: (Node | string)[];
};
/** The implementation must validate the shared L.2 schema and the deck's restricted text subset. */
export interface RichTextCodec {
  parse(nodes: (Node | string)[], target: Y.XmlFragment): void;
  serialize(source: Y.XmlFragment): (Node | string)[];
}
export type ElementType =
  | "text"
  | "shape"
  | "image"
  | "table"
  | "icon"
  | "connector"
  | "group";
export type ElementData = {
  id: string;
  type: ElementType;
  parent: string;
  order: string;
  props: Record<string, string>;
  style: Record<string, string>;
  text?: Node[];
};
export type SlideData = {
  id: string;
  order: string;
  layout: Record<string, string>;
  background: string;
  transition: string;
  duration: string;
  notes: string;
  elements: ElementData[];
};
export type Observation = {
  slide: SlideData;
  revision: string;
  elementRevisions: Record<string, string>;
};
export type WriteResult = {
  applied: string[];
  skipped: { id: string; reason: string }[];
};

const idPattern = /^[A-Za-z0-9_-]{1,80}$/;
const orderPattern = /^[A-Za-z0-9]+$/;
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
const escape = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;")
    .replaceAll(">", "&gt;");
function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`);
}
function checkId(value: string, path: string) {
  if (!idPattern.test(value)) {
    fail(path, "invalid id");
  }
}
function checkOrder(value: string, path: string) {
  if (!orderPattern.test(value)) {
    fail(path, "invalid order");
  }
}
function validateStyle(key: string, value: string, path: string) {
  if (!styles.has(key)) {
    fail(path, `unknown style ${key}`);
  }
  const color = /^(#[0-9a-fA-F]{3,8}|transparent)$/;
  const length = /^(0|[1-9][0-9]{0,3})(\.[0-9]{1,2})?px$/;
  const valid = key.endsWith("color")
    ? color.test(value)
    : key === "font-family"
      ? /^[A-Za-z0-9 _-]{1,80}$/.test(value)
      : key === "font-weight"
        ? /^(normal|bold|[1-9]00)$/.test(value)
        : key === "opacity"
          ? /^(0(\.\d{1,2})?|1(\.0{1,2})?)$/.test(value)
          : length.test(value);
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
      /^-?\d{1,5}(\.\d{1,2})?$/.test(value) &&
      (!["w", "h"].includes(key) || Number(value) > 0);
  }
  if (key === "flow") {
    valid = /^(pinned|flow)$/.test(value);
  }
  if (key === "src") {
    valid = /^\/files\/[A-Za-z0-9_/-]+$/.test(value) && !value.includes("..");
  }
  if (key === "rows" || key === "cols") {
    valid = /^[1-9]\d{0,3}$/.test(value);
  }
  if (key === "build-in" || key === "build-out") {
    valid = effects.has(value);
  }
  if (key === "build-order") {
    valid = /^[1-9]\d?$/.test(value) && Number(value) <= 50;
  }
  if (key === "build-trigger") {
    valid = /^(click|withPrevious|afterPrevious)$/.test(value);
  }
  if (!valid) {
    fail(path, `invalid property ${key}`);
  }
}
function validateSlide(slide: SlideData) {
  const path = `/slide[@id='${slide.id}']`;
  checkId(slide.id, path);
  checkOrder(slide.order, path);
  if (
    !(
      /^(none|fade|push|magic)$/.test(slide.transition) &&
      /^\d{1,5}$/.test(slide.duration)
    )
  ) {
    fail(path, "invalid transition");
  }
  validateStyle("background-color", slide.background, path);
  for (const [key, value] of Object.entries(slide.layout)) {
    if (
      !(
        (key === "display" && /^(flex|grid)$/.test(value)) ||
        (key === "direction" && /^(row|column)$/.test(value)) ||
        (key === "gap" && /^(0|[1-9]\d{0,3})px$/.test(value))
      )
    ) {
      fail(path, `invalid layout ${key}`);
    }
  }
  if (slide.elements.length > 200) {
    fail(path, "element limit exceeded");
  }
  const ids = new Set<string>();
  let cells = 0;
  for (const e of slide.elements) {
    const p = `${path}/element[@id='${e.id}']`;
    checkId(e.id, p);
    checkOrder(e.order, p);
    if (ids.has(e.id) || !types.has(e.type)) {
      fail(p, "duplicate id or invalid type");
    }
    ids.add(e.id);
    for (const [k, v] of Object.entries(e.props)) {
      validateProp(k, v, p);
    }
    for (const [k, v] of Object.entries(e.style)) {
      validateStyle(k, v, p);
    }
    if (e.type !== "text" && e.text?.length) {
      fail(p, "text only allowed in text elements");
    }
    if (e.type === "table") {
      cells += Number(e.props.rows || 0) * Number(e.props.cols || 0);
    }
  }
  if (cells > 4000) {
    fail(path, "table cell limit exceeded");
  }
  for (const e of slide.elements) {
    if (e.parent !== slide.id) {
      const parent = slide.elements.find((item) => item.id === e.parent);
      if (!parent || parent.type !== "group" || parent.id === e.id) {
        fail(path, `invalid parent for ${e.id}`);
      }
      const seen = new Set([e.id]);
      let current: ElementData | undefined = parent;
      while (current && current.parent !== slide.id) {
        if (seen.has(current.id)) {
          fail(path, "group cycle");
        }
        seen.add(current.id);
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
    ? escape(n)
    : `<${n.tag}${Object.entries(n.attrs)
        .sort()
        .map(([k, v]) => ` ${k}="${escape(v)}"`)
        .join("")}>${n.children.map(renderNode).join("")}</${n.tag}>`;
}
function parseXml(html: string): Node {
  const parser = new SaxesParser();
  const stack: Node[] = [];
  let root: Node | undefined;
  const path = () => `/${stack.map((n) => n.tag).join("/") || "slide"}`;
  parser.on("opentag", (tag) => {
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
function attrs(node: Node, allowed: string[], path: string) {
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
export function parseSlide(html: string, codec: RichTextCodec): SlideData {
  const root = parseXml(html);
  const path = "/slide";
  if (root.tag !== "slide") {
    fail(path, "expected slide");
  }
  attrs(
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
  let notes = false;
  for (const child of root.children) {
    if (typeof child === "string") {
      if (child.trim()) {
        fail(path, "unexpected text");
      }
      continue;
    }
    const p = `${path}/${child.tag}`;
    if (child.tag === "notes") {
      attrs(child, [], p);
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
    attrs(
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
      const temp = new Y.Doc();
      const fragment = temp.getXmlFragment("text");
      try {
        codec.parse(child.children, fragment);
        e.text = codec.serialize(fragment).map((n) => {
          if (typeof n === "string") {
            fail(p, "text codec must return block nodes");
          }
          return n;
        });
      } catch (error) {
        fail(p, `invalid rich text: ${String(error)}`);
      } finally {
        temp.destroy();
      }
    } else if (child.children.some((n) => typeof n !== "string" || n.trim())) {
      fail(p, "unexpected content");
    }
    slide.elements.push(e);
  }
  validateSlide(slide);
  return slide;
}
export function serializeSlide(slide: SlideData): string {
  validateSlide(slide);
  const root: Node = {
    attrs: {
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
          children: e.text ?? [],
          tag: "element",
        })
      ),
    ],
    tag: "slide",
  };
  return renderNode(root);
}
type SharedMap = Y.Map<unknown>;
const map = (value: unknown): SharedMap => {
  if (!(value instanceof Y.Map)) {
    throw new Error("invalid scene map");
  }
  return value;
};
const str = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new Error("invalid scene value");
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
    if (!(key in values)) {
      target.delete(key);
    }
  }
  for (const [k, v] of Object.entries(values)) {
    if (target.get(k) !== v) {
      target.set(k, v);
    }
  }
}
function newMap(values: Record<string, string>): SharedMap {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(values)) {
    m.set(k, v);
  }
  return m;
}
export class Deck {
  readonly doc: Y.Doc;
  readonly codec: RichTextCodec;
  constructor(doc: Y.Doc, codec: RichTextCodec) {
    this.doc = doc;
    this.codec = codec;
  }
  private get slides(): SharedMap {
    return this.doc.getMap("slides");
  }
  ids(): string[] {
    return [...this.slides.keys()].sort((a, b) => {
      const aa = str(map(this.slides.get(a)).get("order"));
      const bb = str(map(this.slides.get(b)).get("order"));
      return aa < bb ? -1 : aa > bb ? 1 : a < b ? -1 : a > b ? 1 : 0;
    });
  }
  addSlide(slide: SlideData): void {
    validateSlide(slide);
    if (this.slides.size >= 500 || this.slides.has(slide.id)) {
      throw new Error("slide limit or duplicate id");
    }
    this.doc.transact(() => {
      const s = new Y.Map<unknown>();
      s.set("elements", new Y.Map());
      s.set("layout", new Y.Map());
      s.set("notes", new Y.Text());
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
    const snapshot = this.read(slideId).slide;
    const element = snapshot.elements.find((item) => item.id === elementId);
    if (!element) {
      throw new Error("element missing");
    }
    element[area][key] = value;
    validateSlide(snapshot);
    map(map(map(this.slides.get(slideId)).get("elements")).get(elementId)).get(
      area
    ) instanceof Y.Map || fail("/slide/element", "invalid map");
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
  read(id: string): Observation {
    const s = map(this.slides.get(id));
    const notes = s.get("notes");
    if (!(notes instanceof Y.Text)) {
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
          if (!(fragment instanceof Y.XmlFragment)) {
            throw new Error("invalid text");
          }
          result.text = this.codec.serialize(fragment).map((n) => {
            if (typeof n === "string") {
              throw new Error("invalid text block");
            }
            return n;
          });
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
    validateSlide(slide);
    return {
      elementRevisions: Object.fromEntries(
        elements.map((e) => [e.id, canonical(e)])
      ),
      revision: canonical(slide),
      slide,
    };
  }
  private applyElement(target: SharedMap, e: ElementData) {
    for (const key of ["type", "parent", "order"] as const) {
      if (target.get(key) !== e[key]) {
        target.set(key, e[key]);
      }
    }
    setKeys(map(target.get("props")), e.props);
    setKeys(map(target.get("style")), e.style);
    if (e.type === "text") {
      let fragment = target.get("text");
      if (!(fragment instanceof Y.XmlFragment)) {
        fragment = new Y.XmlFragment();
        target.set("text", fragment);
      }
      const xml = fragment as Y.XmlFragment;
      if (canonical(this.codec.serialize(xml)) !== canonical(e.text ?? [])) {
        xml.delete(0, xml.length);
        this.codec.parse(e.text ?? [], xml);
      }
    }
  }
  private applySlide(target: SharedMap, slide: SlideData) {
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
    if (!(notes instanceof Y.Text)) {
      throw new Error("invalid notes");
    }
    if (notes.toString() !== slide.notes) {
      notes.delete(0, notes.length);
      notes.insert(0, slide.notes);
    }
    const elements = map(target.get("elements"));
    for (const e of slide.elements) {
      let entry = elements.get(e.id);
      if (!(entry instanceof Y.Map)) {
        entry = new Y.Map();
        (entry as SharedMap).set("props", new Y.Map());
        (entry as SharedMap).set("style", new Y.Map());
        elements.set(e.id, entry);
      }
      this.applyElement(map(entry), e);
    }
  }
  write(id: string, html: string, observed: Observation): WriteResult {
    const desired = parseSlide(html, this.codec);
    if (
      id !== desired.id ||
      id !== observed.slide.id ||
      observed.revision !== canonical(observed.slide)
    ) {
      throw new Error("invalid observation");
    }
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
      if (
        (a && observed.elementRevisions[eid] !== canonical(a)) ||
        canonical(a) !== canonical(c)
      ) {
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
    ] as const;
    const final = { ...current.slide, elements: [...merged.values()] };
    for (const key of slideKeys) {
      if (canonical(observed.slide[key]) === canonical(desired[key])) {
        continue;
      }
      if (canonical(observed.slide[key]) !== canonical(current.slide[key])) {
        result.skipped.push({ id, reason: `${key} changed since read` });
        continue;
      }
      Object.assign(final, { [key]: desired[key] });
      result.applied.push(`${id}:${key}`);
    }
    validateSlide(final);
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
export { generateKeyBetween };
