import {
  type ElementData,
  type Node,
  orderedElements,
  type SlideData,
} from "@repo/live-deck";
import pptxgen from "pptxgenjs";
import { shell } from "./document";
import {
  assetLoader,
  bound,
  deckInput,
  escapeHTML,
  limits,
  type OwnAssets,
  type Warning,
  warn,
} from "./input";

const PX = 96;
const alphaColor = /^#[a-f\d]{4}$|^#[a-f\d]{8}$/i;
export interface DeckPage {
  height: number;
  width: number;
}
const defaultPage = { height: 720, width: 1280 };
function pageSize(page: DeckPage) {
  if (
    ![page.width, page.height].every(
      (v) => Number.isFinite(v) && v >= 96 && v <= 4096
    )
  ) {
    throw new Error("export_page_size");
  }
  return { ...page };
}
interface Box {
  h: number;
  rotate: number;
  w: number;
  x: number;
  y: number;
}
/** Pinned coordinates are local to the parent. Flow requires the browser layout engine and is refused for PPTX. */
function box(e: ElementData, parent: Box): Box {
  const num = (key: string, fallback: number) =>
    e.props[key] === undefined ? fallback : Number(e.props[key]);
  return {
    h: num("h", parent.h),
    rotate: num("rotate", 0),
    w: num("w", parent.w),
    x: parent.x + num("x", 0),
    y: parent.y + num("y", 0),
  };
}
function color(value: string | undefined, fallback: string) {
  if (!value || value === "transparent") {
    return fallback;
  }
  const hex = value.slice(1);
  return hex.length === 3 || hex.length === 4
    ? hex
        .slice(0, 3)
        .split("")
        .map((c) => c + c)
        .join("")
    : hex.slice(0, 6);
}
function nodesHTML(nodes: (Node | string)[]): string {
  return nodes
    .map((n) => {
      if (typeof n === "string") {
        return escapeHTML(n);
      }
      if (n.tag === "a") {
        return nodesHTML(n.children); // no navigation/fetch in print document
      }
      let attrs = "";
      if (n.tag === "span") {
        attrs = ` style="${escapeHTML(n.attrs.style)}"`;
      }
      if (n.tag === "ol") {
        attrs = ` start="${Number(n.attrs.start ?? 1)}"`;
      }
      let checkbox = "";
      if (n.tag === "li" && n.attrs["data-type"] === "taskItem") {
        checkbox = n.attrs["data-checked"] === "true" ? "☑ " : "☐ ";
      }
      return `<${n.tag}${attrs}>${checkbox}${nodesHTML(n.children)}${n.tag === "br" ? "" : `</${n.tag}>`}`;
    })
    .join("");
}
function richRuns(
  nodes: (Node | string)[],
  inherited: pptxgen.TextPropsOptions = {}
): pptxgen.TextProps[] {
  return nodes.flatMap((n) => {
    if (typeof n === "string") {
      return [{ options: { ...inherited }, text: n }];
    }
    const options = { ...inherited };
    if (n.tag === "strong") {
      options.bold = true;
    }
    if (n.tag === "em") {
      options.italic = true;
    }
    if (n.tag === "u") {
      options.underline = { style: "sng" };
    }
    if (n.tag === "s") {
      options.strike = true;
    }
    if (n.tag === "code") {
      options.fontFace = "Courier New";
    }
    if (n.tag === "span") {
      options.color = color(n.attrs.style?.split(":")[1]?.trim(), "111827");
    }
    const children = richRuns(n.children, options);
    if (["p", "li", "br"].includes(n.tag)) {
      children.push({ options: { ...options }, text: "\n" });
    }
    return children;
  });
}
function warningsFor(slide: SlideData, warnings: Warning[]) {
  if (slide.transition !== "none") {
    warn(
      warnings,
      "transition_omitted",
      slide.id,
      "Static exports omit slide transitions."
    );
  }
  for (const e of slide.elements) {
    if (e.type === "group" && Object.keys(e.style).length) {
      warn(
        warnings,
        "group_style",
        `${slide.id}/${e.id}`,
        "Group styles do not inherit into children in static exports."
      );
    }
    if (Object.keys(e.props).some((k) => k.startsWith("build-"))) {
      warn(
        warnings,
        "build_omitted",
        `${slide.id}/${e.id}`,
        "Static export shows the final element state."
      );
    }
    if (e.type === "text" || e.type === "table") {
      warn(
        warnings,
        "text_layout",
        `${slide.id}/${e.id}`,
        "Font substitution and line wrapping depend on the reader. Lists and links in PPTX use plain paragraph presentation."
      );
    }
    if (
      e.style.opacity ||
      Object.values(e.style).some((v) => alphaColor.test(v))
    ) {
      warn(
        warnings,
        "alpha_approximation",
        `${slide.id}/${e.id}`,
        "PPTX color alpha and opacity are approximated as opaque colors."
      );
    }
  }
}
function traversal(slide: SlideData, page: DeckPage) {
  const result: { element: ElementData; box: Box }[] = [];
  const visit = (parent: string, b: Box) => {
    for (const element of orderedElements(slide, parent)) {
      const rect = box(element, b);
      result.push({ box: rect, element });
      if (element.type === "group" && element.props.flow !== "flow") {
        visit(element.id, rect);
      }
    }
  };
  visit(slide.id, { h: page.height, rotate: 0, w: page.width, x: 0, y: 0 });
  return result;
}
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Explicit per-element Office mapping with structured omission warnings.
export async function deckPPTX(
  snapshot: Uint8Array,
  assets: OwnAssets,
  requestedPage: DeckPage = defaultPage
) {
  const page = pageSize(requestedPage);
  const scene = deckInput(snapshot, assets),
    warnings: Warning[] = [],
    load = assetLoader(assets);
  const pptx = new pptxgen();
  pptx.defineLayout({
    height: page.height / PX,
    name: "EXPORT",
    width: page.width / PX,
  });
  pptx.layout = "EXPORT";
  const fonts = Object.values(scene.theme.fonts);
  pptx.theme = {
    bodyFontFace: fonts[0] ?? "Arial",
    headFontFace: fonts[0] ?? "Arial",
  };
  for (const slide of scene.slides) {
    warningsFor(slide, warnings);
    const out = pptx.addSlide();
    out.background = { color: color(slide.background, "FFFFFF") };
    out.addNotes(slide.notes);
    for (const { element: e, box: b } of traversal(slide, page)) {
      const path = `${slide.id}/${e.id}`;
      if (e.props.flow && e.props.flow !== "pinned") {
        warn(
          warnings,
          "flow_unsupported",
          path,
          "PPTX requires explicit pinned geometry; element omitted."
        );
        continue;
      }
      if (e.type === "group") {
        if (b.rotate) {
          warn(
            warnings,
            "group_rotation",
            path,
            "Group rotation omitted; child coordinates remain local offsets."
          );
        }
        continue;
      }
      if (b.w <= 0 || b.h <= 0) {
        warn(warnings, "empty_geometry", path, "Non-positive box omitted.");
        continue;
      }
      const opts = {
        h: b.h / PX,
        rotate: ((b.rotate % 360) + 360) % 360,
        w: b.w / PX,
        x: b.x / PX,
        y: b.y / PX,
      };
      const style = {
        bold:
          e.style["font-weight"] === "bold" ||
          Number(e.style["font-weight"] ?? 400) >= 600,
        breakLine: false,
        color: color(e.style.color, "111827"),
        fontFace: e.style["font-family"] ?? fonts[0] ?? "Arial",
        fontSize: Number.parseFloat(e.style["font-size"] ?? "24") * 0.75,
        margin: 0,
      };
      if (e.type === "image") {
        // biome-ignore lint/performance/noAwaitInLoops: Bound image memory and retain painter order.
        const a = await load(e.props.src ?? "");
        out.addImage({ ...opts, altText: e.props.alt ?? "", data: a.data });
      } else if (e.type === "text") {
        out.addText(richRuns(e.text ?? []), { ...opts, ...style });
      } else if (e.type === "table") {
        const rows = Number(e.props.rows),
          cols = Number(e.props.cols);
        const data = Array.from({ length: rows }, (_unusedRow, r) =>
          Array.from({ length: cols }, (_unusedCol, c) => ({
            options: { ...style },
            text: richRuns(e.cells?.[`${r}:${c}`] ?? []),
          }))
        );
        out.addTable(data, {
          ...opts,
          ...style,
          autoPage: false,
          border: { color: color(e.style["border-color"], "888888"), pt: 0.5 },
          colW: Array.from({ length: cols }, () => b.w / PX / cols),
          rowH: b.h / PX / rows,
        });
      } else if (e.type === "shape") {
        const shape =
          {
            ellipse: pptx.ShapeType.ellipse,
            line: pptx.ShapeType.line,
            rect: pptx.ShapeType.rect,
            triangle: pptx.ShapeType.triangle,
          }[e.props.shape ?? "rect"] ?? pptx.ShapeType.rect;
        out.addShape(shape, {
          ...opts,
          fill: {
            color: color(e.style["background-color"], "FFFFFF"),
            transparency:
              e.style["background-color"] === "transparent" ? 100 : 0,
          },
          line: {
            color: color(e.style["border-color"], "111827"),
            width: Number.parseFloat(e.style["border-width"] ?? "1") * 0.75,
          },
        });
      } else {
        warn(
          warnings,
          "element_unsupported",
          path,
          `${e.type} omitted from PPTX.`
        );
      }
      if (
        e.style["text-align"] ||
        e.style["line-height"] ||
        e.style["border-radius"]
      ) {
        warn(
          warnings,
          "style_approximation",
          path,
          "PPTX omits text alignment, line-height or border radius overrides."
        );
      }
    }
  }
  const value = await pptx.write({
    compression: true,
    outputType: "uint8array",
  });
  if (!(value instanceof Uint8Array)) {
    throw new Error("export_pptx_output");
  }
  bound(value, limits.output);
  return { value, warnings };
}
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Explicit per-element safe static mapping.
export async function deckPrintHTML(
  snapshot: Uint8Array,
  assets: OwnAssets,
  requestedPage: DeckPage = defaultPage
) {
  const page = pageSize(requestedPage);
  const scene = deckInput(snapshot, assets),
    warnings: Warning[] = [],
    load = assetLoader(assets);
  let body = "";
  for (const slide of scene.slides) {
    warningsFor(slide, warnings);
    if (slide.notes) {
      warn(
        warnings,
        "notes_omitted",
        slide.id,
        "Print slides omit speaker notes; PPTX retains them."
      );
    }
    let elements = "";
    for (const { element: e, box: b } of traversal(slide, page)) {
      const path = `${slide.id}/${e.id}`;
      if (e.type === "group") {
        if (b.rotate) {
          warn(
            warnings,
            "group_rotation",
            path,
            "Group rotation omitted; children retain local offsets."
          );
        }
        if (Object.keys(e.style).length) {
          warn(
            warnings,
            "group_style",
            path,
            "Group styles do not inherit into children in static exports."
          );
        }
        continue;
      }
      if (e.props.flow && e.props.flow !== "pinned") {
        warn(
          warnings,
          "flow_unsupported",
          path,
          "Static export requires pinned geometry; element omitted."
        );
        continue;
      }
      const style = `left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;transform:rotate(${b.rotate}deg);${Object.entries(
        e.style
      )
        .map(([k, v]) => `${k}:${v}`)
        .join(";")}`;
      let content = "";
      if (e.type === "text") {
        content = nodesHTML(e.text ?? []);
      } else if (e.type === "image") {
        // biome-ignore lint/performance/noAwaitInLoops: Bound image memory and retain painter order.
        const a = await load(e.props.src ?? "");
        content = `<img src="${a.data}" alt="${escapeHTML(e.props.alt)}">`;
      } else if (e.type === "table") {
        for (let r = 0; r < Number(e.props.rows); r += 1) {
          content += "<tr>";
          for (let c = 0; c < Number(e.props.cols); c += 1) {
            content += `<td>${nodesHTML(e.cells?.[`${r}:${c}`] ?? [])}</td>`;
          }
          content += "</tr>";
        }
        content = `<table>${content}</table>`;
      } else if (e.type === "shape") {
        const shape = e.props.shape ?? "rect";
        const shapes: Record<string, string> = {
          ellipse: '<div class="ellipse"></div>',
          line: "<hr>",
          rect: '<div class="rect"></div>',
          triangle: '<div class="triangle"></div>',
        };
        content = shapes[shape] ?? shapes.rect ?? "";
      } else {
        warn(
          warnings,
          "element_unsupported",
          path,
          `${e.type} omitted from print.`
        );
        continue;
      }
      elements += `<div class="element" style="${escapeHTML(style)}">${content}</div>`;
    }
    body += `<section class="slide" style="background:${escapeHTML(slide.background)}">${elements}</section>`;
  }
  const css = `@page{size:${page.width / 96}in ${page.height / 96}in;margin:0}*{box-sizing:border-box}body{margin:0;font:24px Arial,sans-serif}.slide{position:relative;width:${page.width}px;height:${page.height}px;overflow:hidden;break-after:page;page-break-after:always}.slide:last-child{break-after:auto;page-break-after:auto}.element{position:absolute;overflow:hidden;white-space:pre-wrap}p{margin:0}img,table{width:100%;height:100%}img{object-fit:fill}table{border-collapse:collapse}td{border:1px solid #888;vertical-align:top}.rect,.ellipse,.triangle{width:100%;height:100%;background:inherit;border:inherit}.ellipse{border-radius:50%}.triangle{clip-path:polygon(50% 0,100% 100%,0 100%)}hr{border:0;border-top:1px solid currentColor}`;
  return { value: shell(body, css), warnings };
}
