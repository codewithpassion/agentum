import type { JSONContent } from "@tiptap/core";
import {
  Document,
  type ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
} from "docx";
import {
  assetLoader,
  bound,
  documentInput,
  escapeHTML,
  type LoadAsset,
  limits,
  type OwnAssets,
  type Warning,
  warn,
} from "./input";

function text(node: JSONContent): string {
  return node.text ?? String(node.attrs?.label ?? node.attrs?.intent ?? "");
}
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Exhaustive shared-schema node mapping; no raw HTML ingress.
async function htmlNode(
  n: JSONContent,
  load: LoadAsset,
  warnings: Warning[],
  path: string
): Promise<string> {
  let body = (
    await Promise.all(
      (n.content ?? []).map((c, i) =>
        htmlNode(c, load, warnings, `${path}/${i}`)
      )
    )
  ).join("");
  if (n.type === "text") {
    body = escapeHTML(n.text);
    for (const mark of n.marks ?? []) {
      const tag = (
        {
          bold: "strong",
          code: "code",
          italic: "em",
          strike: "s",
          underline: "u",
        } as Record<string, string>
      )[mark.type];
      if (tag) {
        body = `<${tag}>${body}</${tag}>`;
      } else if (mark.type === "textStyle") {
        body = `<span style="color:${escapeHTML(mark.attrs?.color)}">${body}</span>`;
      } else if (mark.type === "link") {
        warn(
          warnings,
          "link_as_text",
          path,
          "Links are printed as text; no external relationship is fetched."
        );
      }
    }
    return body;
  }
  if (n.type === "image") {
    const image = await load(String(n.attrs?.src));
    return `<img src="${image.data}" alt="${escapeHTML(n.attrs?.alt)}" width="${Math.min(image.width, 650)}">`;
  }
  if (n.type === "mention" || n.type === "date") {
    return `<span class="chip">${escapeHTML(text(n))}</span>`;
  }
  if (n.type === "pending") {
    warn(warnings, "pending", path, "Pending content exported as placeholder.");
    return `<p>[Pending: ${escapeHTML(text(n))}]</p>`;
  }
  if (n.type === "hardBreak") {
    return "<br>";
  }
  if (n.type === "horizontalRule") {
    return "<hr>";
  }
  const tag =
    n.type === "heading"
      ? `h${n.attrs?.level}`
      : (
          {
            blockquote: "blockquote",
            bulletList: "ul",
            codeBlock: "pre",
            doc: "main",
            listItem: "li",
            orderedList: "ol",
            paragraph: "p",
            table: "table",
            tableCell: "td",
            tableHeader: "th",
            tableRow: "tr",
            taskItem: "li",
            taskList: "ul",
          } as Record<string, string>
        )[n.type ?? ""];
  if (!tag) {
    throw new Error("export_unmapped_document_node");
  }
  let attrs = "";
  if (n.type === "orderedList") {
    attrs = ` start="${Number(n.attrs?.start ?? 1)}"`;
  }
  if (["tableCell", "tableHeader"].includes(n.type ?? "")) {
    attrs = ` colspan="${Number(n.attrs?.colspan ?? 1)}" rowspan="${Number(n.attrs?.rowspan ?? 1)}" style="background:${escapeHTML(n.attrs?.backgroundColor ?? "transparent")}"`;
  }
  let checkbox = "";
  if (n.type === "taskItem") {
    checkbox = n.attrs?.checked ? "☑ " : "☐ ";
  }
  return `<${tag}${attrs}>${checkbox}${body}</${tag}>`;
}
export const printCSS =
  "@page{size:A4;margin:18mm}*{box-sizing:border-box}body{margin:0;color:#111827;font:12pt Arial,sans-serif;overflow-wrap:anywhere}p{margin:0 0 8pt;orphans:3;widows:3}h1,h2,h3{break-after:avoid}table{border-collapse:collapse;width:100%}tr,img{break-inside:avoid}th,td{border:1px solid #888;padding:5pt;vertical-align:top}thead{display:table-header-group}img{max-width:100%;height:auto}pre{white-space:pre-wrap}.chip{background:#eee;border-radius:3pt;padding:1pt 3pt}";
export function shell(body: string, css = printCSS) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>${css}</style></head><body>${body}</body></html>`;
  bound(new TextEncoder().encode(html), limits.output);
  return html;
}
export async function documentPrintHTML(
  snapshot: Uint8Array,
  assets: OwnAssets
) {
  const json = documentInput(snapshot, assets),
    warnings: Warning[] = [];
  return {
    value: shell(
      await htmlNode(json, assetLoader(assets), warnings, "/document")
    ),
    warnings,
  };
}

type Inline = TextRun | ImageRun | ExternalHyperlink;
async function runs(n: JSONContent, load: LoadAsset): Promise<Inline[]> {
  if (n.type === "image") {
    const a = await load(String(n.attrs?.src));
    const scale = Math.min(1, 624 / a.width);
    return [
      new ImageRun({
        altText: {
          description: String(n.attrs?.alt ?? ""),
          name: "Image",
          title: "Image",
        },
        data: a.bytes,
        transformation: { height: a.height * scale, width: a.width * scale },
        type: "png",
      }),
    ];
  }
  if (n.type === "hardBreak") {
    return [new TextRun({ break: 1 })];
  }
  if (n.type === "text" || n.type === "mention" || n.type === "date") {
    const marks = n.marks ?? [];
    const has = (m: string) => marks.some((v) => v.type === m);
    const run = new TextRun({
      bold: has("bold"),
      color: marks.find((m) => m.type === "textStyle")?.attrs?.color?.slice(1),
      font: has("code") ? "Courier New" : undefined,
      italics: has("italic"),
      strike: has("strike"),
      text: text(n),
      underline: has("underline") ? {} : undefined,
    });
    // Deliberately no external links: document policy is looser than export relationship policy.
    return [run];
  }
  return (
    await Promise.all((n.content ?? []).map((c) => runs(c, load)))
  ).flat();
}
interface BlockContext {
  checkbox?: boolean;
  level: number;
  list?: string;
  lists: WeakMap<JSONContent, string>;
  load: LoadAsset;
  path: string;
  quote?: boolean;
  warnings: Warning[];
}
async function childBlocks(n: JSONContent, context: BlockContext) {
  return (
    await Promise.all(
      (n.content ?? []).map((c, i) =>
        blocks(c, { ...context, path: `${context.path}/${i}` })
      )
    )
  ).flat();
}
async function tableBlock(n: JSONContent, context: BlockContext) {
  const rows = await Promise.all(
    (n.content ?? []).map(
      async (row, r) =>
        new TableRow({
          children: await Promise.all(
            (row.content ?? []).map(async (cell, c) => {
              if (cell.attrs?.colwidth) {
                warn(
                  context.warnings,
                  "table_width",
                  context.path,
                  "DOCX uses automatic column widths."
                );
              }
              return new TableCell({
                children: await childBlocks(cell, {
                  ...context,
                  list: undefined,
                  path: `${context.path}/${r}/${c}`,
                }),
                columnSpan: Number(cell.attrs?.colspan ?? 1),
                rowSpan: Number(cell.attrs?.rowspan ?? 1),
                shading: cell.attrs?.backgroundColor
                  ? { fill: String(cell.attrs.backgroundColor).slice(1) }
                  : undefined,
              });
            })
          ),
        })
    )
  );
  return new Table({ rows });
}
async function blocks(
  n: JSONContent,
  context: BlockContext
): Promise<(Paragraph | Table)[]> {
  const { load, warnings, path } = context;
  if (n.type === "doc") {
    return childBlocks(n, context);
  }
  if (n.type === "blockquote") {
    return childBlocks(n, { ...context, quote: true });
  }
  if (["bulletList", "orderedList", "taskList"].includes(n.type ?? "")) {
    if (context.level >= 9) {
      warn(
        warnings,
        "list_depth",
        path,
        "Office numbering supports nine nesting levels; deeper lists use level nine."
      );
    }
    return childBlocks(n, {
      ...context,
      level: context.level + 1,
      list: context.lists.get(n),
    });
  }
  if (n.type === "listItem") {
    return childBlocks(n, context);
  }
  if (n.type === "taskItem") {
    return childBlocks(n, {
      ...context,
      checkbox: n.attrs?.checked === true,
      list: undefined,
    });
  }
  if (n.type === "table") {
    return [await tableBlock(n, context)];
  }
  if (n.type === "pending") {
    warn(warnings, "pending", path, "Pending content exported as placeholder.");
  }
  const children =
    n.type === "pending"
      ? [new TextRun(`[Pending: ${text(n)}]`)]
      : await runs(n, load);
  if (context.checkbox !== undefined) {
    children.unshift(new TextRun(context.checkbox ? "☑ " : "☐ "));
  }
  const headings = [
    HeadingLevel.HEADING_1,
    HeadingLevel.HEADING_2,
    HeadingLevel.HEADING_3,
  ];
  return [
    new Paragraph({
      border:
        n.type === "horizontalRule"
          ? { bottom: { color: "888888", size: 6, style: "single" } }
          : undefined,
      children,
      heading:
        n.type === "heading" ? headings[Number(n.attrs?.level) - 1] : undefined,
      indent: context.quote ? { left: 360 } : undefined,
      numbering: context.list
        ? {
            level: Math.min(8, Math.max(0, context.level - 1)),
            reference: context.list,
          }
        : undefined,
    }),
  ];
}
export async function documentDOCX(snapshot: Uint8Array, assets: OwnAssets) {
  const json = documentInput(snapshot, assets),
    warnings: Warning[] = [],
    lists = new WeakMap<JSONContent, string>();
  const numbering: {
    reference: string;
    levels: {
      level: number;
      format: typeof LevelFormat.BULLET | typeof LevelFormat.DECIMAL;
      text: string;
      start: number;
    }[];
  }[] = [];
  const visit = (n: JSONContent, path: string) => {
    if (n.type === "bulletList" || n.type === "orderedList") {
      const reference = `list-${numbering.length}`,
        ordered = n.type === "orderedList";
      lists.set(n, reference);
      numbering.push({
        levels: Array.from({ length: 9 }, (_, level) => ({
          format: ordered ? LevelFormat.DECIMAL : LevelFormat.BULLET,
          level,
          start: Number(n.attrs?.start ?? 1),
          text: ordered ? `%${level + 1}.` : "•",
        })),
        reference,
      });
    }
    if (n.marks?.some((m) => m.type === "link")) {
      warn(warnings, "link_as_text", path, "Hyperlinks exported as text.");
    }
    for (const [index, c] of (n.content ?? []).entries()) {
      visit(c, `${path}/${index}`);
    }
  };
  visit(json, "/document");
  const children = await blocks(json, {
    level: 0,
    lists,
    load: assetLoader(assets),
    path: "/document",
    warnings,
  });
  const doc = new Document({
    numbering: { config: numbering },
    sections: [{ children }],
  });
  const value = new Uint8Array(await Packer.toArrayBuffer(doc));
  bound(value, limits.output);
  return { value, warnings };
}
