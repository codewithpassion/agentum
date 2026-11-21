import { expect, test } from "bun:test";
import type { MemoryNote } from "@repo/db/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { TeamNotes } from "./team-notes.tsx";

const note = (
  overrides: Partial<MemoryNote> & Pick<MemoryNote, "id">
): MemoryNote => ({
  date: "2026-11-01",
  kind: "people",
  source: null,
  text: "A note",
  userScope: null,
  writtenBy: "person",
  ...overrides,
});

const BUTTON_OPENING = /<button[^>]*>/;

test("no notes shows the empty state and no list", () => {
  const html = renderToStaticMarkup(<TeamNotes notes={[]} />);
  expect(html).toContain(
    "The team has no shared notes yet. A team dream lifts what three members hold into team memory."
  );
  expect(html).not.toContain('data-testid="team-notes"');
});

test("two kinds render in MEMORY_NOTE_KINDS order under their labels", () => {
  const html = renderToStaticMarkup(
    <TeamNotes
      notes={[
        note({ id: "w1", kind: "work", text: "Drafting the Q4 plan" }),
        note({ id: "p1", kind: "people", text: "Ana leads sales" }),
      ]}
    />
  );
  const people = html.indexOf("About people");
  const work = html.indexOf("Work in progress");
  expect(people).toBeGreaterThan(-1);
  expect(work).toBeGreaterThan(people);
  expect(html).toContain("<h3");
  expect(html.indexOf("Ana leads sales")).toBeLessThan(
    html.indexOf("Drafting the Q4 plan")
  );
});

test("inside a group the newest note date comes first", () => {
  const html = renderToStaticMarkup(
    <TeamNotes
      notes={[
        note({ date: "2026-10-20", id: "old", text: "Oldest note" }),
        note({ date: "2026-11-11", id: "new", text: "Newest note" }),
        note({ date: "2026-11-01", id: "mid", text: "Middle note" }),
      ]}
    />
  );
  const newest = html.indexOf("Newest note");
  const middle = html.indexOf("Middle note");
  const oldest = html.indexOf("Oldest note");
  expect(newest).toBeGreaterThan(-1);
  expect(middle).toBeGreaterThan(newest);
  expect(oldest).toBeGreaterThan(middle);
  expect(html).toContain("11 Nov");
  expect(html).toContain("20 Oct");
});

test("the list has no button", () => {
  const html = renderToStaticMarkup(
    <TeamNotes notes={[note({ id: "p1", text: "Ana leads sales" })]} />
  );
  expect(html).toContain('data-testid="team-notes"');
  expect(html).not.toMatch(BUTTON_OPENING);
});
