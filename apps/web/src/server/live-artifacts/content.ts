// DOM-free serialization of the validated shared schema. No markdown HTML parser
// or browser DOM is involved in checkpoint publication.
import { LiveDocument } from "@repo/live-doc";
import type {
  LiveContentCodec,
  LiveRoomScope,
} from "@repo/services/live-artifacts/service";
import { applyUpdate, Doc, encodeStateAsUpdate } from "yjs";

type Node = ReturnType<LiveDocument["json"]>;
const escapeHtml = (value: unknown) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
const renderMarks = (node: Node, initial: string): string => {
  let body = initial;
  for (const mark of node.marks ?? []) {
    const tags: Record<string, string> = {
      bold: "strong",
      code: "code",
      italic: "em",
      strike: "s",
      underline: "u",
    };
    if (tags[mark.type]) {
      body = `<${tags[mark.type]}>${body}</${tags[mark.type]}>`;
    }
    if (mark.type === "link") {
      body = `<a href="${escapeHtml(mark.attrs?.href)}" target="_blank" rel="noopener noreferrer">${body}</a>`;
    }
    if (mark.type === "textStyle" && mark.attrs?.color) {
      body = `<span style="color:${escapeHtml(mark.attrs.color)}">${body}</span>`;
    }
  }
  return body;
};
const render = (node: Node): string => {
  const attrs = node.attrs ?? {};
  let body =
    node.text === undefined
      ? (node.content ?? []).map(render).join("")
      : escapeHtml(node.text);
  body = renderMarks(node, body);
  switch (node.type) {
    case "doc":
    case "text":
      return body;
    case "hardBreak":
      return "<br>";
    case "horizontalRule":
      return "<hr>";
    case "image":
      return `<img src="${escapeHtml(attrs.src)}" alt="${escapeHtml(attrs.alt)}">`;
    case "mention":
    case "date":
      return `<span>${escapeHtml(attrs.label)}</span>`;
    case "pending":
      return `<div data-pending="">${escapeHtml(attrs.intent)}</div>`;
    case "heading":
      return `<h${attrs.level}>${body}</h${attrs.level}>`;
    case "codeBlock":
      return `<pre><code>${body}</code></pre>`;
    case "taskItem":
      return `<li data-checked="${attrs.checked === true}">${body}</li>`;
    case "orderedList":
      return `<ol start="${escapeHtml(attrs.start ?? 1)}">${body}</ol>`;
    case "tableCell":
    case "tableHeader": {
      const tag = node.type === "tableCell" ? "td" : "th";
      return `<${tag} colspan="${escapeHtml(attrs.colspan ?? 1)}" rowspan="${escapeHtml(attrs.rowspan ?? 1)}"${attrs.backgroundColor ? ` style="background-color:${escapeHtml(attrs.backgroundColor)}"` : ""}>${body}</${tag}>`;
    }
    default: {
      const tags: Record<string, string> = {
        blockquote: "blockquote",
        bulletList: "ul",
        listItem: "li",
        paragraph: "p",
        table: "table",
        tableRow: "tr",
        taskList: "ul",
      };
      const tag = tags[node.type ?? ""];
      if (!tag) {
        throw new Error("Unsupported document node");
      }
      return `<${tag}>${body}</${tag}>`;
    }
  }
};
export const documentContent = (
  policy:
    | ReadonlySet<string>
    | ((scope?: LiveRoomScope) => Promise<ReadonlySet<string>>) = new Set()
): LiveContentCodec => {
  const load = async (state?: Uint8Array, scope?: LiveRoomScope) => {
    const doc = new Doc({ gc: false });
    try {
      if (state) {
        applyUpdate(doc, state);
      }
      return new LiveDocument(doc, {
        ownBlobUrls:
          typeof policy === "function" ? await policy(scope) : policy,
      });
    } catch (error) {
      doc.destroy();
      throw error;
    }
  };
  const close = (live: LiveDocument) => {
    live.destroy();
    live.doc.destroy();
  };
  return {
    async exportDocument(snapshot, scope) {
      const live = await load(snapshot.state, scope);
      try {
        return {
          html: `<!doctype html><html><head><meta charset="utf-8"></head><body>${render(live.json())}</body></html>`,
          markdown: live.markdown(),
        };
      } finally {
        close(live);
      }
    },
    async importMarkdown(markdown) {
      const live = await load();
      try {
        live.import({ markdown }, {});
        return { revision: 0, state: encodeStateAsUpdate(live.doc) };
      } finally {
        close(live);
      }
    },
    async loadDocument(state, scope) {
      const live = await load(state, scope);
      try {
        return { revision: 0, state: encodeStateAsUpdate(live.doc) };
      } finally {
        close(live);
      }
    },
  };
};
