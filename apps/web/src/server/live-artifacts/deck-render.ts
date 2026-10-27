import {
  type ElementData,
  type Node,
  orderedElements,
  type SlideData,
} from "@repo/live-deck";

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
/** Input has passed Deck + production codec validation. Still escape every value
 * at the HTML boundary. Never insert constrained slide interchange as raw HTML. */
function text(nodes: (Node | string)[]): string {
  return nodes
    .map((node) => {
      if (typeof node === "string") {
        return escapeHtml(node);
      }
      const attrs = Object.entries(node.attrs)
        .map(([key, value]) => ` ${key}="${escapeHtml(value)}"`)
        .join("");
      if (node.tag === "br") {
        return "<br>";
      }
      return `<${node.tag}${attrs}>${text(node.children)}</${node.tag}>`;
    })
    .join("");
}
const css = (values: Record<string, string>) =>
  escapeHtml(
    Object.entries(values)
      .map(([key, value]) => `${key}:${value}`)
      .join(";")
  );
function geometry(element: ElementData) {
  const p: Partial<Record<string, string>> = element.props;
  const values: Record<string, string> = {
    ...element.style,
    "box-sizing": "border-box",
  };
  if (p.flow === "flow") {
    values.position = "relative";
    for (const key of [
      "flex-grow",
      "flex-shrink",
      "flex-basis",
      "align-self",
      "grid-row",
      "grid-column",
    ]) {
      if (p[key]) {
        values[key] = p[key];
      }
    }
  } else {
    values.position = "absolute";
    values.left = `${p.x ?? 0}px`;
    values.top = `${p.y ?? 0}px`;
  }
  if (p.w) {
    values.width = `${p.w}px`;
  }
  if (p.h) {
    values.height = `${p.h}px`;
  }
  if (p.rotate) {
    values.transform = `rotate(${p.rotate}deg)`;
  }
  decorateGeometry(element, values);
  return css(values);
}
function decorateGeometry(
  element: ElementData,
  values: Record<string, string>
) {
  const p = element.props;
  if (element.type === "shape") {
    values["background-color"] ||= "#e2e8f0";
    if (p.shape === "line") {
      values.height = "0";
      values["border-top"] =
        `${element.style["border-width"] || "2px"} solid ${element.style.color || "#334155"}`;
    }
  }
  if (element.type === "connector") {
    values.left = "0";
    values.top = "0";
    values.width = "1280px";
    values.height = "720px";
  }
  if (element.type === "shape" && p.shape === "ellipse") {
    values["border-radius"] = "50%";
  }
  if (element.type === "shape" && p.shape === "triangle") {
    values["clip-path"] = "polygon(50% 0,100% 100%,0 100%)";
  }
}
function table(element: ElementData) {
  const rows = Number(element.props.rows),
    cols = Number(element.props.cols);
  return `<table style="border-collapse:collapse;width:100%;height:100%">${Array.from({ length: rows }, (_, row) => `<tr>${Array.from({ length: cols }, (_cell, col) => `<td style="border:1px solid #999">${text(element.cells?.[`${row}:${col}`] ?? [])}</td>`).join("")}</tr>`).join("")}</table>`;
}
interface Point {
  x: number;
  y: number;
}
function localTransform(
  point: Point,
  element: ElementData,
  inverse = false
): Point {
  const p: Partial<Record<string, string>> = element.props;
  const cx = Number(p.w ?? 0) / 2,
    cy = Number(p.h ?? 0) / 2;
  const x = Number(p.x ?? 0),
    y = Number(p.y ?? 0);
  const angle = ((Number(p.rotate ?? 0) * Math.PI) / 180) * (inverse ? -1 : 1);
  const dx = point.x - cx - (inverse ? x : 0),
    dy = point.y - cy - (inverse ? y : 0);
  return {
    x: dx * Math.cos(angle) - dy * Math.sin(angle) + cx + (inverse ? 0 : x),
    y: dx * Math.sin(angle) + dy * Math.cos(angle) + cy + (inverse ? 0 : y),
  };
}
function ancestors(slide: SlideData, id: string): ElementData[] {
  const path: ElementData[] = [];
  let current = slide.elements.find((e) => e.id === id);
  while (current) {
    path.push(current);
    current = slide.elements.find((e) => e.id === current?.parent);
  }
  return path;
}
function connectorPoint(
  slide: SlideData,
  element: ElementData,
  endpoint: "from" | "to"
): Point {
  const target = slide.elements.find((e) => e.id === element.props[endpoint]);
  if (!target) {
    throw new Error("Validated connector endpoint missing");
  }
  const w = Number(target.props.w || "0"),
    h = Number(target.props.h || "0");
  const anchor = element.props[`${endpoint}-anchor`];
  let point = { x: w / 2, y: h / 2 };
  if (anchor === "left") {
    point.x = 0;
  }
  if (anchor === "right") {
    point.x = w;
  }
  if (anchor === "top") {
    point.y = 0;
  }
  if (anchor === "bottom") {
    point.y = h;
  }
  for (const parent of ancestors(slide, target.id)) {
    point = localTransform(point, parent);
  }
  for (const parent of ancestors(slide, element.parent).reverse()) {
    point = localTransform(point, parent, true);
  }
  return point;
}
function connector(slide: SlideData, element: ElementData) {
  const from = connectorPoint(slide, element, "from"),
    to = connectorPoint(slide, element, "to");
  return `<svg width="1280" height="720" style="overflow:visible" aria-label="Connector"><line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="${escapeHtml(element.style.color || "#334155")}" stroke-width="${escapeHtml(element.style["border-width"] || "2px")}"/></svg>`;
}
function content(element: ElementData, slide: SlideData): string {
  const props: Partial<Record<string, string>> = element.props;
  switch (element.type) {
    case "text":
      return text(element.text ?? []);
    case "embed":
      return `<div role="note">Sandboxed embed unavailable in static export. Open the live deck as an authorized member.</div>`;
    case "image":
      return `<img src="${escapeHtml(props.src ?? "")}" alt="${escapeHtml(props.alt ?? "")}" style="width:100%;height:100%;object-fit:contain">`;
    case "table":
      return table(element);
    case "icon":
      return `<span aria-label="${escapeHtml(props.icon ?? "")}">${escapeHtml(props.icon ?? "")}</span>`;
    case "group":
      return elements(slide, element.id);
    case "connector":
      return connector(slide, element);
    default:
      return "";
  }
}
function elements(slide: SlideData, parent: string): string {
  return orderedElements(slide, parent)
    .map(
      (element) =>
        `<div data-element="${escapeHtml(element.id)}" style="${geometry(element)}">${content(element, slide)}</div>`
    )
    .join("");
}
export const renderDeckCheckpoint = (slides: SlideData[], title: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{margin:0;background:#eee;font-family:system-ui}section{position:relative;width:1280px;height:720px;margin:24px auto;overflow:hidden}p{margin:0}a{color:inherit}</style></head><body>${slides.map((slide) => `<section aria-label="Slide ${escapeHtml(slide.id)}" style="background:${escapeHtml(slide.background)};${css(Object.fromEntries(Object.entries(slide.layout).map(([key, value]) => [key === "direction" ? "flex-direction" : key, value])))}">${elements(slide, slide.id)}</section>`).join("")}</body></html>`;
