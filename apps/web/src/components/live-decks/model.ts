import {
  type Deck,
  type ElementData,
  generateKeyBetween,
  type SlideData,
  serializeSlide,
} from "@repo/live-deck";
import { richTextCodec } from "@repo/live-deck/rich-text";
import { UndoManager } from "yjs";
import { canEditDeck, type DeckEditorPorts } from "./ports";

export const newId = () => crypto.randomUUID().replaceAll("-", "_");
export function emptySlide(deck: Deck): SlideData {
  const last = deck.ids().at(-1);
  return {
    background: "#ffffff",
    duration: "350",
    elements: [],
    id: newId(),
    layout: {
      direction: "column",
      display: "flex",
      gap: "16px",
      padding: "24px",
    },
    notes: "",
    order: generateKeyBetween(last ? deck.read(last).slide.order : null, null),
    transition: "none",
  };
}
export function newElement(
  slide: SlideData,
  type: ElementData["type"]
): ElementData {
  const last = [...slide.elements]
    .sort((a, b) => (a.order < b.order ? -1 : Number(a.order > b.order)))
    .at(-1);
  const element: ElementData = {
    id: newId(),
    order: generateKeyBetween(last?.order ?? null, null),
    parent: slide.id,
    props: {
      flow: "pinned",
      h: "160",
      rotate: "0",
      w: "320",
      x: "80",
      y: "80",
    },
    style: { color: "#111827", "font-size": "28px" },
    type,
  };
  if (type === "text") {
    element.text = [{ attrs: {}, children: ["Edit text"], tag: "p" }];
  }
  if (type === "shape") {
    element.props.shape = "rect";
    element.style["background-color"] = "#3b82f6";
  }
  if (type === "table") {
    element.props.rows = "2";
    element.props.cols = "2";
    element.cells = Object.fromEntries(
      ["0:0", "0:1", "1:0", "1:1"].map((key) => [
        key,
        [{ attrs: {}, children: [], tag: "p" }],
      ])
    );
  }
  if (type === "icon") {
    element.props.icon = "star";
  }
  return element;
}
/** One origin per mounted editor; remote/null-origin transactions never enter its scene history. */
export class DeckCommands {
  readonly origin = {};
  private readonly gestures = new Set<string>();
  readonly undo: UndoManager;
  private readonly ports: () => DeckEditorPorts;
  constructor(ports: () => DeckEditorPorts) {
    this.ports = ports;
    const { doc } = ports().deck;
    this.undo = new UndoManager(
      [doc.getMap("slides"), doc.getMap("meta"), doc.getMap("sections")],
      { captureTimeout: 500, trackedOrigins: new Set([this.origin]) }
    );
  }
  run(action: (deck: Deck) => void) {
    const ports = this.ports();
    if (!canEditDeck(ports)) {
      throw new Error(
        "Editing requires an editor role, a synchronized provider and an initialized shared theme"
      );
    }
    if (!this.gestures.has("pointer")) {
      this.undo.stopCapturing();
    }
    ports.deck.doc.transact(() => action(ports.deck), this.origin);
    if (!this.gestures.has("pointer")) {
      this.undo.stopCapturing();
    }
  }
  gesture(phase: "start" | "end") {
    this.undo.stopCapturing();
    if (phase === "start") {
      this.gestures.add("pointer");
    } else {
      this.gestures.delete("pointer");
    }
  }
  destroy() {
    this.undo.destroy();
  }
}
export function patchNotes(deck: Deck, slideId: string, next: string) {
  const slide = deck.doc
    .getMap("slides")
    .get(slideId) as import("yjs").Map<unknown>;
  const notes = slide.get("notes") as import("yjs").Text;
  const previous = notes.toString();
  let start = 0;
  while (
    start < previous.length &&
    start < next.length &&
    previous[start] === next[start]
  ) {
    start += 1;
  }
  let suffix = 0;
  while (
    suffix < previous.length - start &&
    suffix < next.length - start &&
    previous.at(-suffix - 1) === next.at(-suffix - 1)
  ) {
    suffix += 1;
  }
  // Validate notes through core first, then preserve Y.Text identity and untouched characters.
  serializeSlide({ ...deck.read(slideId).slide, notes: next }, richTextCodec);
  notes.delete(start, previous.length - start - suffix);
  notes.insert(start, next.slice(start, next.length - suffix));
}
export interface BuildEvent {
  effect: string;
  elementId: string;
  order: number;
  phase: "in" | "out";
  trigger: string;
}
export function buildSteps(slide: SlideData): BuildEvent[][] {
  const events: BuildEvent[] = [];
  for (const element of slide.elements) {
    for (const phase of ["in", "out"] as const) {
      const effect = element.props[`build-${phase}`];
      if (effect) {
        events.push({
          effect,
          elementId: element.id,
          order: Number(element.props["build-order"] ?? 1),
          phase,
          trigger: element.props["build-trigger"] ?? "click",
        });
      }
    }
  }
  events.sort(
    (a, b) =>
      a.order - b.order ||
      a.phase.localeCompare(b.phase) ||
      a.elementId.localeCompare(b.elementId)
  );
  const steps: BuildEvent[][] = [];
  for (const event of events) {
    // An element's exit always occurs after its entrance, even for withPrevious.
    if (
      !steps.length ||
      event.trigger !== "withPrevious" ||
      steps.at(-1)?.some((previous) => previous.elementId === event.elementId)
    ) {
      steps.push([]);
    }
    steps.at(-1)?.push(event);
  }
  return steps;
}

/** Preserve the visible pinned coordinates while changing group membership. */
export function groupSelection(
  deck: Deck,
  slideId: string,
  ids: string[]
): string {
  const { slide } = deck.read(slideId);
  const selected = slide.elements.filter((element) => ids.includes(element.id));
  const [first] = selected;
  if (!first || selected.length < 2) {
    throw new Error("Select two sibling elements");
  }
  const group = newElement(slide, "group");
  group.parent = first.parent;
  const x = Math.min(...selected.map((e) => Number(e.props.x ?? 0)));
  const y = Math.min(...selected.map((e) => Number(e.props.y ?? 0)));
  const w =
    Math.max(
      ...selected.map((e) => Number(e.props.x ?? 0) + Number(e.props.w ?? 240))
    ) - x;
  const h =
    Math.max(
      ...selected.map((e) => Number(e.props.y ?? 0) + Number(e.props.h ?? 120))
    ) - y;
  group.props = {
    flow: "pinned",
    h: String(Math.max(1, h)),
    rotate: "0",
    w: String(Math.max(1, w)),
    x: String(x),
    y: String(y),
  };
  deck.groupElements(slideId, group, ids);
  deck.updateElements(
    slideId,
    Object.fromEntries(
      selected.map((e) => [
        e.id,
        {
          props: {
            ...e.props,
            x: String(Number(e.props.x ?? 0) - x),
            y: String(Number(e.props.y ?? 0) - y),
          },
        },
      ])
    )
  );
  return group.id;
}
export function ungroupSelection(deck: Deck, slideId: string, groupId: string) {
  const { slide } = deck.read(slideId);
  const group = slide.elements.find((e) => e.id === groupId);
  if (!group) {
    throw new Error("Group missing");
  }
  const angle = (Number(group.props.rotate ?? 0) * Math.PI) / 180;
  const cx = Number(group.props.w ?? 0) / 2,
    cy = Number(group.props.h ?? 0) / 2;
  const number = (value: number) => String(Math.round(value * 100) / 100);
  const patches = Object.fromEntries(
    slide.elements
      .filter((e) => e.parent === groupId)
      .map((e) => {
        const dx = Number(e.props.x ?? 0) + Number(e.props.w ?? 0) / 2 - cx;
        const dy = Number(e.props.y ?? 0) + Number(e.props.h ?? 0) / 2 - cy;
        return [
          e.id,
          {
            props: {
              ...e.props,
              rotate: number(
                Number(e.props.rotate ?? 0) + Number(group.props.rotate ?? 0)
              ),
              x: number(
                Number(group.props.x ?? 0) +
                  cx +
                  dx * Math.cos(angle) -
                  dy * Math.sin(angle) -
                  Number(e.props.w ?? 0) / 2
              ),
              y: number(
                Number(group.props.y ?? 0) +
                  cy +
                  dx * Math.sin(angle) +
                  dy * Math.cos(angle) -
                  Number(e.props.h ?? 0) / 2
              ),
            },
          },
        ];
      })
  );
  deck.updateElements(slideId, patches);
  deck.ungroupElements(slideId, groupId);
}
