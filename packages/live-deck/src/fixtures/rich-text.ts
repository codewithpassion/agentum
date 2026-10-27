import type { Node, SlideData } from "../index";
export const node = (
  tag: string,
  children: (Node | string)[] = [],
  attrs: Record<string, string> = {}
): Node => ({ attrs, children, tag });
export const rich = [
  node("p", [
    "Unicode 👩🏽‍🚀 é 中文 <&> \r\n\t",
    node("br"),
    node("strong", ["bold", node("em", [" and italic"])]),
    node("em", ["italic"]),
    node("u", ["underline"]),
    node("s", ["strike"]),
    node("code", ["<literal>"]),
    node("a", ["link"], {
      href: "https://example.com/?q=1&b=2",
      rel: "noopener noreferrer",
      target: "_blank",
    }),
    node("span", ["color"], { style: "color: #3b82f6" }),
  ]),
  node("ul", [
    node("li", [
      node("p", ["bullet"]),
      node("ol", [node("li", [node("p", ["nested"])])], { start: "3" }),
    ]),
  ]),
  node(
    "ul",
    [
      node("li", [node("p", ["task"])], {
        "data-checked": "true",
        "data-type": "taskItem",
      }),
    ],
    { "data-type": "taskList" }
  ),
  node("p"),
];
export function slide(): SlideData {
  return {
    background: "#ffffff",
    duration: "0",
    elements: [
      {
        id: "text",
        order: "a0",
        parent: "s",
        props: { h: "200", w: "200", x: "0", y: "0" },
        style: {},
        text: rich,
        type: "text",
      },
      {
        cells: { "0:0": rich },
        id: "table",
        order: "a1",
        parent: "s",
        props: { cols: "1", h: "200", rows: "1", w: "200", x: "0", y: "0" },
        style: {},
        type: "table",
      },
    ],
    id: "s",
    layout: {},
    notes: "",
    order: "a0",
    transition: "none",
  };
}
