/** biome-ignore-all lint/suspicious/noUnnecessaryConditions: Geometry keys in the core string dictionaries are optional. */
import type { ElementData, SlideData } from "@repo/live-deck";

const number = (value: number) => String(Math.round(value * 100) / 100);
const coordinate = (element: ElementData, key: string) =>
  Number(element.props[key] ?? 0);
type Patches = Record<string, Partial<Omit<ElementData, "id">>>;
function resizeChildren(
  all: ElementData[],
  group: ElementData,
  patch: Record<string, string>,
  patches: Patches
) {
  const sx = Number(patch.w) / coordinate(group, "w"),
    sy = Number(patch.h) / coordinate(group, "h");
  for (const child of all.filter((e) => e.parent === group.id)) {
    const props = { ...child.props };
    for (const key of ["x", "w"]) {
      props[key] = number(coordinate(child, key) * sx);
    }
    for (const key of ["y", "h"]) {
      props[key] = number(coordinate(child, key) * sy);
    }
    patches[child.id] = { props };
    if (child.type === "group") {
      resizeChildren(all, child, props, patches);
    }
  }
}
export function transformPatches(
  slide: SlideData,
  id: string,
  patch: Record<string, string>,
  selection: string[]
): Patches {
  const element = slide.elements.find((e) => e.id === id);
  if (!element) {
    return {};
  }
  const moving = patch.x !== undefined && patch.y !== undefined;
  const targets =
    moving && selection.includes(id)
      ? slide.elements.filter(
          (e) => selection.includes(e.id) && e.parent === element.parent
        )
      : [element];
  const dx = Number(patch.x) - coordinate(element, "x"),
    dy = Number(patch.y) - coordinate(element, "y");
  const patches: Patches = {};
  for (const target of targets) {
    const update =
      target.id === id
        ? patch
        : {
            x: number(coordinate(target, "x") + dx),
            y: number(coordinate(target, "y") + dy),
          };
    patches[target.id] = { props: { ...target.props, ...update } };
  }
  if (element.type === "group" && patch.w && patch.h) {
    resizeChildren(slide.elements, element, patch, patches);
  }
  return patches;
}
export function scenePoint(
  slide: SlideData,
  element: ElementData,
  anchor = "center"
): { x: number; y: number } {
  const w = coordinate(element, "w"),
    h = coordinate(element, "h");
  let x = w / 2,
    y = h / 2;
  if (anchor === "left") {
    x = 0;
  }
  if (anchor === "right") {
    x = w;
  }
  if (anchor === "top") {
    y = 0;
  }
  if (anchor === "bottom") {
    y = h;
  }
  let current: ElementData | undefined = element;
  while (current) {
    const cx = coordinate(current, "w") / 2,
      cy = coordinate(current, "h") / 2;
    const angle = (coordinate(current, "rotate") * Math.PI) / 180;
    const dx = x - cx,
      dy = y - cy;
    x =
      coordinate(current, "x") +
      cx +
      dx * Math.cos(angle) -
      dy * Math.sin(angle);
    y =
      coordinate(current, "y") +
      cy +
      dx * Math.sin(angle) +
      dy * Math.cos(angle);
    const { parent }: { parent: string } = current;
    current = slide.elements.find((e) => e.id === parent);
  }
  return { x, y };
}
export function alignmentPatches(
  slide: SlideData,
  selection: string[],
  axis: "x" | "y",
  mode: "start" | "center" | "end"
): Patches {
  const elements = slide.elements.filter((element) =>
    selection.includes(element.id)
  );
  const [first] = elements;
  if (!first) {
    return {};
  }
  if (elements.some((element) => element.parent !== first.parent)) {
    throw new Error("Align elements within the same group");
  }
  const size = axis === "x" ? "w" : "h";
  const low = Math.min(...elements.map((element) => coordinate(element, axis)));
  const high = Math.max(
    ...elements.map(
      (element) => coordinate(element, axis) + coordinate(element, size)
    )
  );
  return Object.fromEntries(
    elements.map((element) => {
      let value = low;
      if (mode === "center") {
        value = (low + high - coordinate(element, size)) / 2;
      }
      if (mode === "end") {
        value = high - coordinate(element, size);
      }
      return [
        element.id,
        { props: { ...element.props, [axis]: number(value) } },
      ];
    })
  );
}
