import { Extension, getSchema, type JSONContent, Node } from "@tiptap/core";
import { Image } from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { Color, TextStyle } from "@tiptap/extension-text-style";
import { UniqueID } from "@tiptap/extension-unique-id";
import { MarkdownManager } from "@tiptap/markdown";
import { Plugin } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { Lexer, Marked, type marked, Tokenizer } from "marked";

export const BLOCK_TYPES = [
  "paragraph",
  "heading",
  "blockquote",
  "bulletList",
  "orderedList",
  "listItem",
  "taskList",
  "taskItem",
  "codeBlock",
  "horizontalRule",
  "image",
  "table",
  "tableRow",
  "tableCell",
  "tableHeader",
  "pending",
];
export const THEME_COLORS = [
  "#111827",
  "#6b7280",
  "#ef4444",
  "#f59e0b",
  "#10b981",
  "#3b82f6",
  "#8b5cf6",
  "#ffffff",
];
export interface ContentPolicy {
  /** Exact same-origin /files paths verified by the service to belong to this artifact. Fail closed by default. */
  ownBlobUrls?: ReadonlySet<string>;
}
const chip = (name: string) =>
  Node.create({
    addAttributes: () => ({ label: { default: "" }, value: { default: "" } }),
    atom: true,
    group: "inline",
    inline: true,
    name,
    parseHTML: () => [{ tag: `span[data-${name}]` }],
    renderHTML: ({ node }) => [
      "span",
      { [`data-${name}`]: node.attrs.value },
      node.attrs.label,
    ],
    renderMarkdown: (node) => String(node.attrs?.label ?? ""),
  });
const Pending = Node.create({
  addAttributes: () => ({ intent: { default: "" } }),
  atom: true,
  group: "block",
  name: "pending",
  parseHTML: () => [{ tag: "div[data-pending]" }],
  renderHTML: ({ node }) => ["div", { "data-pending": "" }, node.attrs.intent],
  renderMarkdown: (node) => `[Pending: ${String(node.attrs?.intent ?? "")}]`,
});
const CellColor = Extension.create({
  addGlobalAttributes: () => [
    {
      attributes: {
        backgroundColor: {
          default: null,
          parseHTML: (el) => el.style.backgroundColor,
          renderHTML: (attrs) =>
            THEME_COLORS.includes(attrs.backgroundColor)
              ? { style: `background-color: ${attrs.backgroundColor}` }
              : {},
        },
      },
      types: ["tableCell", "tableHeader"],
    },
  ],
  name: "cellColor",
});
/** Reject unsafe editor transactions before the collaboration binding publishes them. Sanitize initial/pasted JSON explicitly too. */
export function createSanitizerPlugin(policy: ContentPolicy = {}) {
  return new Plugin({
    filterTransaction: (transaction) => {
      if (!transaction.docChanged) {
        return true;
      }
      try {
        return transaction.doc.eq(
          transaction.doc.type.schema.nodeFromJSON(
            sanitizeJSON(transaction.doc.toJSON(), policy)
          )
        );
      } catch {
        return false;
      }
    },
  });
}
/** The single extension list for both the editor and DOM-free room. Add collaboration separately; history is disabled. */
export function createExtensions(policy: ContentPolicy = {}) {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: {
        HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" },
        openOnClick: false,
      },
      undoRedo: false,
    }),
    TableKit.configure({ table: { resizable: false } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Image,
    TextStyle,
    Color,
    chip("mention"),
    chip("date"),
    Pending,
    CellColor,
    Extension.create({
      addProseMirrorPlugins: () => [createSanitizerPlugin(policy)],
      name: "safeContent",
    }),
    UniqueID.configure({
      generateID: () => crypto.randomUUID(),
      types: BLOCK_TYPES,
    }),
  ];
}
export const extensions = createExtensions();
export const schema = getSchema(extensions);
// A private lexer avoids changing marked defaults used by other packages. HTML
// tokens are consumed as space before Tiptap can invoke its DOM HTML converter.
const lexer = Object.assign(new Marked(), { Lexer });
lexer.use({
  tokenizer: {
    html(src) {
      const token = Tokenizer.prototype.html.call(this, src);
      return token
        ? ({ ...token, text: "", type: "space" } as unknown as ReturnType<
            Tokenizer["html"]
          >)
        : undefined;
    },
    tag(src) {
      const token = Tokenizer.prototype.tag.call(this, src);
      return token
        ? ({ ...token, text: "", type: "space" } as unknown as ReturnType<
            Tokenizer["tag"]
          >)
        : undefined;
    },
  },
});
// MarkdownManager types require the callable singleton; its implementation only
// uses the instance lexer/defaults/use methods, which this adapter supplies.
const markdown = new MarkdownManager({
  extensions,
  marked: lexer as unknown as typeof marked,
});
// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject URL control characters rather than letting the URL parser normalize them.
const UNSAFE_URL = /[\u0000-\u0020\u007f\\]/;
const LOCAL_URL = /^\/(?!\/)/;
const ENCODED_SEPARATOR = /%(?:2f|5c|00|0a|0d)/i;
const IMAGE_PATH = /^\/files\/[A-Za-z0-9/_\-.]+$/;
const BLOCK_ID = /^[\w.-]{1,200}$/;
const LANGUAGE = /^[\w+-]{1,40}$/;
export function safeLink(value: unknown): string | undefined {
  if (typeof value !== "string" || UNSAFE_URL.test(value)) {
    return;
  }
  if (LOCAL_URL.test(value) && !ENCODED_SEPARATOR.test(value)) {
    return value;
  }
  try {
    const url = new URL(value);
    if (["http:", "https:", "mailto:"].includes(url.protocol)) {
      return value;
    }
  } catch {
    /* invalid URL */
  }
}
function safeImage(value: unknown, policy: ContentPolicy): string | undefined {
  if (
    typeof value === "string" &&
    IMAGE_PATH.test(value) &&
    !value.includes("..") &&
    policy.ownBlobUrls?.has(value)
  ) {
    return value;
  }
}
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Closed per-node attribute grammar is the trust boundary.
function attrsFor(
  type: string,
  raw: Record<string, unknown>,
  policy: ContentPolicy
): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  if (
    BLOCK_TYPES.includes(type) &&
    typeof raw.id === "string" &&
    BLOCK_ID.test(raw.id)
  ) {
    attrs.id = raw.id;
  }
  if (type === "heading") {
    attrs.level = [1, 2, 3].includes(Number(raw.level)) ? Number(raw.level) : 1;
  }
  if (type === "orderedList") {
    attrs.start =
      Number.isSafeInteger(raw.start) && Number(raw.start) > 0 ? raw.start : 1;
  }
  if (type === "taskItem") {
    attrs.checked = raw.checked === true;
  }
  if (type === "codeBlock") {
    attrs.language =
      typeof raw.language === "string" && LANGUAGE.test(raw.language)
        ? raw.language
        : null;
  }
  if (type === "pending") {
    attrs.intent =
      typeof raw.intent === "string" ? raw.intent.slice(0, 500) : "";
  }
  if (type === "mention" || type === "date") {
    attrs.value = typeof raw.value === "string" ? raw.value.slice(0, 200) : "";
    attrs.label = typeof raw.label === "string" ? raw.label.slice(0, 200) : "";
  }
  if (type === "image") {
    attrs.src = safeImage(raw.src, policy);
    attrs.alt = typeof raw.alt === "string" ? raw.alt.slice(0, 1000) : "";
  }
  if (type === "tableCell" || type === "tableHeader") {
    for (const key of ["colspan", "rowspan"]) {
      attrs[key] =
        Number.isInteger(raw[key]) &&
        Number(raw[key]) > 0 &&
        Number(raw[key]) <= 100
          ? raw[key]
          : 1;
    }
    attrs.colwidth =
      Array.isArray(raw.colwidth) &&
      raw.colwidth.length <= 100 &&
      raw.colwidth.every((v) => Number.isInteger(v) && v >= 24 && v <= 2000)
        ? raw.colwidth
        : null;
    attrs.backgroundColor = THEME_COLORS.includes(String(raw.backgroundColor))
      ? raw.backgroundColor
      : null;
  }
  return attrs;
}
/** Drops unknown content and attrs, validates the resulting tree against the actual editor schema. Never parses HTML. */
export function sanitizeJSON(
  input: unknown,
  policy: ContentPolicy = {}
): JSONContent {
  let count = 0;
  const ids = new Set<string>();
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Recursive schema sanitation validates every node at one boundary.
  const clean = (value: unknown, depth: number): JSONContent | undefined => {
    count += 1;
    if (count > 100_000 || depth > 64) {
      throw new Error("content_limit");
    }
    if (!value || typeof value !== "object") {
      return;
    }
    const v = value as JSONContent;
    if (typeof v.type !== "string" || !schema.nodes[v.type]) {
      return;
    }
    if (v.type === "text") {
      if (typeof v.text !== "string" || !v.text) {
        return;
      }
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Each allowed mark has an explicit attribute grammar.
      const marks = (Array.isArray(v.marks) ? v.marks : []).flatMap((mark) => {
        if (!mark || typeof mark !== "object") {
          return [];
        }
        if (
          ["bold", "italic", "underline", "strike", "code"].includes(mark.type)
        ) {
          return [{ type: mark.type }];
        }
        if (mark.type === "link") {
          const href = safeLink(mark.attrs?.href);
          return href
            ? [
                {
                  attrs: { href, rel: "noopener noreferrer", target: "_blank" },
                  type: "link",
                },
              ]
            : [];
        }
        if (
          mark.type === "textStyle" &&
          THEME_COLORS.includes(mark.attrs?.color)
        ) {
          return [{ attrs: { color: mark.attrs?.color }, type: "textStyle" }];
        }
        return [];
      });
      return { marks, text: v.text, type: "text" };
    }
    const attrs = attrsFor(
      v.type,
      v.attrs && typeof v.attrs === "object" ? v.attrs : {},
      policy
    );
    if (typeof attrs.id === "string") {
      if (ids.has(attrs.id)) {
        attrs.id = undefined;
      } else {
        ids.add(attrs.id);
      }
    }
    if (v.type === "image" && !attrs.src) {
      return;
    }
    const content = (Array.isArray(v.content) ? v.content : []).flatMap(
      (child) => {
        const c = clean(child, depth + 1);
        return c ? [c] : [];
      }
    );
    const nodeType = schema.nodes[v.type];
    if (!nodeType) {
      return;
    }
    try {
      const children = content.map((c) => schema.nodeFromJSON(c));
      const node = nodeType.createAndFill(attrs, children);
      if (!node) {
        return;
      }
      node.check();
      return node.toJSON();
    } catch {
      /* Invalid subtrees are omitted. */
    }
  };
  const result = clean(input, 0);
  return result?.type === "doc"
    ? result
    : (schema.topNodeType.createAndFill()?.toJSON() ?? {
        content: [],
        type: "doc",
      });
}
/** Inspection/replacement is synchronous and uses the same DOM-free parser.
 * Resolvers at the authorized service boundary must store bytes before supplying replacements.
 * Replacements still pass the unchanged shared sanitizer and ownership policy. */
export function markdownImageUrls(text: string): string[] {
  const urls = new Set<string>();
  const visit = (node: JSONContent) => {
    if (node.type === "image" && typeof node.attrs?.src === "string") {
      urls.add(node.attrs.src);
    }
    for (const child of node.content ?? []) {
      visit(child);
    }
  };
  visit(markdown.parse(text));
  return [...urls];
}
export function fromMarkdown(
  text: string,
  policy: ContentPolicy = {},
  replacements?: ReadonlyMap<string, string>
): JSONContent {
  const parsed = markdown.parse(text);
  const visit = (node: JSONContent) => {
    if (node.type === "image" && replacements?.has(node.attrs?.src)) {
      node.attrs = { ...node.attrs, src: replacements.get(node.attrs?.src) };
    }
    for (const child of node.content ?? []) {
      visit(child);
    }
  };
  if (replacements) {
    visit(parsed);
  }
  return sanitizeJSON(parsed, policy);
}
export function toMarkdown(json: unknown, policy: ContentPolicy = {}): string {
  return markdown.serialize(sanitizeJSON(json, policy));
}
