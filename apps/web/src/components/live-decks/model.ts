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
  readonly undo: UndoManager;
  private readonly ports: () => DeckEditorPorts;
  constructor(ports: () => DeckEditorPorts) {
    this.ports = ports;
    const { doc } = ports().deck;
    this.undo = new UndoManager(
      [doc.getMap("slides"), doc.getMap("meta"), doc.getMap("sections")],
      { captureTimeout: 0, trackedOrigins: new Set([this.origin]) }
    );
  }
  run(action: (deck: Deck) => void) {
    const ports = this.ports();
    if (!canEditDeck(ports)) {
      throw new Error(
        "Editing requires an editor role and a synchronized provider"
      );
    }
    ports.deck.doc.transact(() => action(ports.deck), this.origin);
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
export function buildSteps(slide: SlideData): ElementData[][] {
  const elements = slide.elements
    .filter((e) => e.props["build-in"] || e.props["build-out"])
    .sort(
      (a, b) =>
        Number(a.props["build-order"] ?? 1) -
          Number(b.props["build-order"] ?? 1) || a.id.localeCompare(b.id)
    );
  const steps: ElementData[][] = [];
  for (const element of elements) {
    if (!steps.length || element.props["build-trigger"] !== "withPrevious") {
      steps.push([]);
    }
    steps.at(-1)?.push(element);
  }
  return steps;
}
