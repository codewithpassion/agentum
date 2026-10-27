/** biome-ignore-all lint/suspicious/useAwait: Fixture callbacks implement the asynchronous production ports with executable local state. */
/** biome-ignore-all lint/performance/noJsxPropsBind: Component event handlers capture the current validated scene and role; descendants are not memoized. */
/** Executable local adapter, never imported by product routes. Updates cross actual Deck admission. */
import { Deck } from "@repo/live-deck";
import { richTextCodec } from "@repo/live-deck/rich-text";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Doc, encodeStateAsUpdate } from "yjs";
import { DeckEditor } from "../deck-editor";
import { emptySlide, newElement } from "../model";
import type {
  DeckEditorPorts,
  DeckParticipant,
  PresentationPosition,
} from "../ports";

const owned = new Set<string>();
const decks = [
  new Deck(new Doc(), richTextCodec, { ownsBlob: (path) => owned.has(path) }),
  new Deck(new Doc(), richTextCodec, { ownsBlob: (path) => owned.has(path) }),
] as const;
const [first, other] = decks;
first.setTheme({ colors: {}, fonts: {}, sizes: {} });
const slide = emptySlide(first);
slide.id = "opening";
slide.duration = "100";
slide.notes = "Opening speaker notes";
slide.transition = "fade";
first.addSlide(slide);
const text = newElement(slide, "text");
text.id = "headline";
first.addElement(slide.id, text);
const shape = newElement(first.read(slide.id).slide, "shape");
shape.id = "blue_box";
shape.props.x = "480";
shape.props["build-in"] = "rise";
shape.props["build-out"] = "fade";
shape.props["build-trigger"] = "click";
shape.props["build-order"] = "1";
first.addElement(slide.id, shape);
const table = newElement(first.read(slide.id).slide, "table");
table.id = "data_table";
table.props.y = "280";
table.props["build-in"] = "fade";
table.props["build-trigger"] = "withPrevious";
table.props["build-order"] = "1";
first.addElement(slide.id, table);
const icon = newElement(first.read(slide.id).slide, "icon");
icon.id = "timed_icon";
icon.props.x = "800";
icon.props.y = "320";
icon.props.w = "80";
icon.props.h = "80";
icon.props["build-in"] = "scale";
icon.props["build-trigger"] = "afterPrevious";
icon.props["build-order"] = "2";
first.addElement(slide.id, icon);
const second = emptySlide(first);
second.id = "closing";
second.transition = "magic";
second.notes = "Closing speaker notes";
first.addSlide(second);
first.addElement(second.id, {
  ...text,
  parent: second.id,
  props: { ...text.props, x: "420", y: "240" },
});
other.applyUpdate(encodeStateAsUpdate(first.doc));
let delivering = false;
for (const source of decks) {
  source.doc.on("update", (update) => {
    if (delivering) {
      return;
    }
    delivering = true;
    try {
      for (const target of decks) {
        if (target !== source) {
          target.applyUpdate(update);
        }
      }
    } finally {
      delivering = false;
    }
  });
}
const roster: DeckParticipant[] = [
  { color: "#3b82f6", id: "alice", kind: "member", name: "Alice" },
  { color: "#10b981", id: "bob", kind: "member", name: "Bob" },
];
function Fixture() {
  const [role, setRole] = useState<DeckEditorPorts["role"]>("editor");
  const [participants, setParticipants] = useState(roster);
  const [spotlight, setSpotlight] = useState<PresentationPosition | null>(null);
  const [events, setEvents] = useState<string[]>([]);
  const record = (value: string) =>
    setEvents((previous) => [...previous, value]);
  const ports = (index: number): DeckEditorPorts => ({
    ask: async (where) => {
      record(`ask:${JSON.stringify(where)}`);
    },
    comment: async (where) => {
      record(`comment:${JSON.stringify(where)}`);
    },
    deck: decks[index] ?? first,
    history: async () => {
      record("history");
    },
    ownsBlob: (path) => owned.has(path),
    participants,
    presentation: spotlight,
    presentToEveryone: async (position) => {
      setSpotlight(position);
      record(`present:${JSON.stringify(position)}`);
    },
    provider: {
      publishPresence: (location) =>
        setParticipants((previous) => {
          const next = previous.map((p, i) =>
            i === index ? { ...p, ...location } : p
          );
          return JSON.stringify(next) === JSON.stringify(previous)
            ? previous
            : next;
        }),
      state: "synced",
    },
    role: index === 0 ? role : "editor",
    selfId: roster[index]?.id ?? "alice",
    upload: async (file) => {
      const response = await fetch("/fixture/upload", {
        body: file,
        method: "POST",
      });
      if (!response.ok) {
        throw new Error("Fixture upload failed");
      }
      const { path } = (await response.json()) as { path: string };
      owned.add(path);
      record(`upload:${file.name}`);
      return { path };
    },
  });
  return (
    <>
      <button
        onClick={() => setRole(role === "editor" ? "viewer" : "editor")}
        type="button"
      >
        Toggle Alice role
      </button>
      <output data-testid="events">{events.join("\n")}</output>
      <div data-replica="alice">
        <DeckEditor ports={ports(0)} />
      </div>
      <div data-replica="bob">
        <DeckEditor ports={ports(1)} />
      </div>
    </>
  );
}
const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing fixture root");
}
createRoot(root).render(<Fixture />);
