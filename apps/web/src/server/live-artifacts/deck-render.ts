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
  if (element.type === "shape" && p.shape === "ellipse") {
    values["border-radius"] = "50%";
  }
  if (element.type === "shape" && p.shape === "triangle") {
    values["clip-path"] = "polygon(50% 0,100% 100%,0 100%)";
  }
  return css(values);
}
function table(element: ElementData) {
  const rows = Number(element.props.rows),
    cols = Number(element.props.cols);
  return `<table style="border-collapse:collapse;width:100%;height:100%">${Array.from({ length: rows }, (_, row) => `<tr>${Array.from({ length: cols }, (_cell, col) => `<td style="border:1px solid #999">${text(element.cells?.[`${row}:${col}`] ?? [])}</td>`).join("")}</tr>`).join("")}</table>`;
}
function content(element: ElementData, slide: SlideData): string {
  const props: Partial<Record<string, string>> = element.props;
  switch (element.type) {
    case "text":
      return text(element.text ?? []);
    case "image":
      return `<img src="${escapeHtml(props.src ?? "")}" alt="${escapeHtml(props.alt ?? "")}" style="width:100%;height:100%;object-fit:contain">`;
    case "table":
      return table(element);
    case "icon":
      return `<span aria-label="${escapeHtml(props.icon ?? "")}">${escapeHtml(props.icon ?? "")}</span>`;
    case "group":
      return elements(slide, element.id);
    case "connector":
      return `<svg width="100%" height="100%" viewBox="0 0 100 100" aria-label="Connector"><line x1="0" y1="0" x2="100" y2="100" stroke="currentColor"/></svg>`;
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
