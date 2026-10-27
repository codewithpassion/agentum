import {
  initProseMirrorDoc,
  safeLink,
  schema,
  THEME_COLORS,
  updateYFragment,
  yXmlFragmentToProseMirrorRootNode,
} from "@repo/live-doc/rich-text";
import { XmlElement, type XmlFragment, XmlText } from "yjs";
import { type Node, type RichTextCodec, validateLinkUrl } from "./index";

const INVALID_XML = /[^\t\n\r\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u;
const BLOCK_ID = /^[\w.-]{1,200}$/;
const COLOR_PREFIX = /^color: /;
const MARK_SUFFIX = /--[a-zA-Z0-9+/=]{8}$/;
const blocks: Record<string, string> = {
  br: "hardBreak",
  li: "listItem",
  ol: "orderedList",
  p: "paragraph",
  ul: "bulletList",
};
const nodeTypes = [...Object.values(blocks), "taskList", "taskItem"];
function nodeTag(type: string): string {
  if (type === "taskList") {
    return "ul";
  }
  if (type === "taskItem") {
    return "li";
  }
  return Object.keys(blocks).find((key) => blocks[key] === type) ?? reject();
}
const marks: Record<string, string> = {
  a: "link",
  code: "code",
  em: "italic",
  s: "strike",
  span: "textStyle",
  strong: "bold",
  u: "underline",
};
const reject = (): never => {
  throw new Error("invalid_deck_rich_text");
};
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Closed HTML attribute grammar validates each supported attribute.
function attrs(tag: string, input: Record<string, unknown>) {
  let allowed: string[] = [];
  if (Object.hasOwn(blocks, tag)) {
    allowed = ["data-id"];
  }
  if (tag === "br") {
    allowed = [];
  }
  if (tag === "ul") {
    allowed = ["data-id", "data-type"];
  }
  if (tag === "li") {
    allowed = ["data-id", "data-type", "data-checked"];
  }
  if (tag === "ol") {
    allowed = ["data-id", "start"];
  }
  if (tag === "a") {
    allowed = ["href", "target", "rel"];
  }
  if (tag === "span") {
    allowed = ["style"];
  }
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    reject();
  }
  const result: Record<string, unknown> = {};
  if (input["data-type"] !== undefined) {
    const expected = tag === "ul" ? "taskList" : "taskItem";
    if (input["data-type"] !== expected) {
      reject();
    }
    if (tag === "li") {
      if (!["true", "false"].includes(String(input["data-checked"]))) {
        reject();
      }
      result.checked = input["data-checked"] === "true";
    }
  } else if (input["data-checked"] !== undefined) {
    reject();
  }
  if (input["data-id"] !== undefined) {
    if (
      typeof input["data-id"] !== "string" ||
      !BLOCK_ID.test(input["data-id"])
    ) {
      reject();
    }
    result.id = input["data-id"];
  }
  if (tag === "ol" && input.start !== undefined) {
    const start = Number(input.start);
    if (
      !Number.isSafeInteger(start) ||
      start < 1 ||
      String(start) !== input.start
    ) {
      reject();
    }
    result.start = start;
  }
  if (tag === "a") {
    if (
      !safeLink(input.href) ||
      input.target !== "_blank" ||
      input.rel !== "noopener noreferrer"
    ) {
      reject();
    }
    validateLinkUrl(String(input.href));
    Object.assign(result, {
      href: input.href,
      rel: input.rel,
      target: input.target,
    });
  }
  if (tag === "span") {
    const color = String(input.style).replace(COLOR_PREFIX, "");
    if (!THEME_COLORS.includes(color) || input.style !== `color: ${color}`) {
      reject();
    }
    result.color = color;
  }
  return result;
}
type PMNode = ReturnType<typeof schema.node>;
type PMMark = ReturnType<typeof schema.mark>;
function parseNodes(nodes: (Node | string)[]): PMNode[] {
  let count = 0;
  const ids = new Set<unknown>();
  const visit = (
    items: (Node | string)[],
    active: PMMark[],
    depth: number
  ): PMNode[] => {
    if (!Array.isArray(items) || depth > 16) {
      reject();
    }
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Recursive strict tree conversion rejects malformed HTML before mutation.
    return items.flatMap((item) => {
      count += 1;
      if (count > 20_000) {
        reject();
      }
      if (typeof item === "string") {
        if (INVALID_XML.test(item)) {
          reject();
        }
        return item ? [schema.text(item, active)] : [];
      }
      if (
        !item ||
        Object.keys(item).some(
          (key) => !["tag", "attrs", "children"].includes(key)
        ) ||
        !item.attrs ||
        typeof item.attrs !== "object" ||
        Array.isArray(item.attrs)
      ) {
        reject();
      }
      if (
        Object.values(item.attrs).some((value) => typeof value !== "string")
      ) {
        reject();
      }
      const values = attrs(item.tag, item.attrs);
      if (values.id !== undefined) {
        if (ids.has(values.id)) {
          reject();
        }
        ids.add(values.id);
      }
      const mark = marks[item.tag];
      if (mark) {
        if (active.some((value) => value.type.name === mark)) {
          reject();
        }
        return visit(
          item.children,
          [...active, schema.mark(mark, values)],
          depth + 1
        );
      }
      const block = item.attrs["data-type"] ?? blocks[item.tag];
      if (!block || active.length) {
        reject();
      }
      return [
        schema.node(
          block ?? reject(),
          values,
          visit(item.children, [], depth + 1)
        ),
      ];
    });
  };
  return visit(nodes, [], 0);
}
function markNode(mark: PMMark): Node {
  const tag =
    Object.keys(marks).find((key) => marks[key] === mark.type.name) ?? reject();
  const attributes: Record<string, string> = {};
  if (tag === "a") {
    Object.assign(attributes, {
      href: mark.attrs.href,
      rel: mark.attrs.rel,
      target: mark.attrs.target,
    });
  }
  if (tag === "span") {
    attributes.style = `color: ${mark.attrs.color}`;
  }
  return { attrs: attributes, children: [], tag };
}
/** Group adjacent runs by their common mark prefix, like the shared DOM serializer. */
function renderChildren(node: PMNode): (Node | string)[] {
  const result: (Node | string)[] = [];
  let active: readonly PMMark[] = [];
  let containers: (Node | string)[][] = [result];
  for (const child of node.children) {
    const next = child.isText ? child.marks : [];
    let common = 0;
    while (
      common < active.length &&
      common < next.length &&
      active[common]?.eq(next[common] ?? reject())
    ) {
      common += 1;
    }
    containers = containers.slice(0, common + 1);
    for (const mark of next.slice(common)) {
      const wrapper = markNode(mark);
      containers.at(-1)?.push(wrapper);
      containers.push(wrapper.children);
    }
    containers
      .at(-1)
      ?.push(child.isText ? (child.text ?? reject()) : render(child));
    active = next;
  }
  return result;
}
function render(node: PMNode): Node {
  const tag = nodeTag(node.type.name);
  const attributes: Record<string, string> = {};
  if (node.attrs.id !== null && node.attrs.id !== undefined) {
    attributes["data-id"] = node.attrs.id;
  }
  if (tag === "ol" && node.attrs.start !== 1) {
    attributes.start = String(node.attrs.start);
  }
  if (node.type.name === "taskList" || node.type.name === "taskItem") {
    attributes["data-type"] = node.type.name;
    if (node.type.name === "taskItem") {
      attributes["data-checked"] = String(node.attrs.checked);
    }
  }
  return { attrs: attributes, children: renderChildren(node), tag };
}
/** Check raw Yjs before PM can discard unknown attributes or marks. */
function validateRaw(source: XmlFragment) {
  let count = 0;
  const ids = new Set<string>();
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Raw XML needs independent checks before the lossy PM projection.
  const visit = (parent: XmlFragment, depth: number) => {
    if (depth > 16) {
      reject();
    }
    const parentType =
      parent instanceof XmlElement
        ? schema.nodes[parent.nodeName]
        : schema.topNodeType;
    let match = parentType?.contentMatch ?? reject();
    for (const child of parent.toArray()) {
      const childType =
        child instanceof XmlElement
          ? schema.nodes[child.nodeName]
          : schema.nodes.text;
      match = (childType && match.matchType(childType)) || reject();
      count += 1;
      if (count > 20_000) {
        reject();
      }
      if (child instanceof XmlElement) {
        if (!nodeTypes.includes(child.nodeName)) {
          reject();
        }
        const type = schema.nodes[child.nodeName] ?? reject();
        const values = child.getAttributes();
        if (values.type !== undefined && values.type !== null) {
          reject();
        }
        if (
          Object.keys(values).some(
            (key) => !Object.hasOwn(type.spec.attrs ?? {}, key)
          )
        ) {
          reject();
        }
        const html: Record<string, unknown> = {};
        if (child.nodeName === "taskList" || child.nodeName === "taskItem") {
          html["data-type"] = child.nodeName;
          if (child.nodeName === "taskItem") {
            if (typeof values.checked !== "boolean") {
              reject();
            }
            html["data-checked"] = String(values.checked);
          }
        }
        if (values.id !== null && values.id !== undefined) {
          if (ids.has(values.id)) {
            reject();
          }
          ids.add(values.id);
          html["data-id"] = values.id;
        }
        if (child.nodeName === "orderedList" && values.start !== undefined) {
          html.start = String(values.start);
        }
        attrs(nodeTag(child.nodeName), html);
        if (values.start !== undefined && typeof values.start !== "number") {
          reject();
        }
        visit(child, depth + 1);
      } else if (child instanceof XmlText) {
        if (Object.keys(child.getAttributes()).length) {
          reject();
        }
        for (const part of child.toDelta()) {
          if (
            typeof part.insert !== "string" ||
            INVALID_XML.test(part.insert)
          ) {
            reject();
          }
          const seen = new Set<string>();
          for (const [name, value] of Object.entries(part.attributes ?? {})) {
            const base = name.replace(MARK_SUFFIX, "");
            if (seen.has(base)) {
              reject();
            }
            seen.add(base);
            const tag =
              Object.keys(marks).find((key) => marks[key] === base) ?? reject();
            if (!value || typeof value !== "object" || Array.isArray(value)) {
              reject();
            }
            const raw = { ...(value as Record<string, unknown>) };
            if (tag === "a") {
              for (const key of ["class", "title"]) {
                if (raw[key] === null) {
                  delete raw[key];
                }
              }
            }
            attrs(tag, tag === "span" ? { style: `color: ${raw.color}` } : raw);
            if (
              tag === "span" &&
              Object.keys(raw).some((key) => key !== "color")
            ) {
              reject();
            }
          }
        }
      } else {
        reject();
      }
    }
    if (parent.length && !match.validEnd) {
      reject();
    }
  };
  if (
    !source.doc ||
    source.doc.store.pendingDs ||
    source.doc.store.pendingStructs
  ) {
    reject();
  }
  visit(source, 0);
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item).sort(([left], [right]) =>
          left.localeCompare(right)
        )
      );
    }
    return item;
  });
}
/** Strict canonical HTML-tree adapter. Bind editors with @repo/live-doc/schema. */
export const richTextCodec: RichTextCodec = {
  parse(nodes, target) {
    const content = parseNodes(nodes);
    const root = schema.node("doc", null, content);
    // Empty fragments are the deck's unallocated/empty text representation.
    if (content.length) {
      root.check();
    }
    if (canonical(root.children.map(render)) !== canonical(nodes)) {
      reject();
    }
    richTextCodec.serialize(target);
    if (!content.length) {
      target.delete(0, target.length);
      return;
    }
    const meta = target.length
      ? initProseMirrorDoc(target, schema).meta
      : { isOMark: new Map(), mapping: new Map() };
    updateYFragment(target.doc ?? reject(), target, root, meta);
  },
  serialize(source) {
    validateRaw(source);
    if (!source.length) {
      return [];
    }
    const root = yXmlFragmentToProseMirrorRootNode(source, schema);
    root.check();
    const result: (Node | string)[] = [];
    for (const node of root.children) {
      result.push(render(node));
    }
    // Validate projected values with the same strict HTML grammar.
    const checked = schema.node("doc", null, parseNodes(result));
    if (!root.eq(checked)) {
      reject();
    }
    return result;
  },
};
