import { expect, test } from "bun:test";
import type { MemoryChange } from "@repo/db/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { ChangesList } from "./changes-list.tsx";
import type { DreamChangeView } from "./dream-changes.ts";
import { SeeChanges } from "./see-changes.tsx";

function makeChange(overrides: Partial<MemoryChange>): MemoryChange {
  return {
    action: "add",
    agentId: "agent-1",
    createdAt: "2026-11-19T22:00:00.000Z",
    decidedAt: null,
    decidedBy: null,
    dreamRunId: "run-1",
    groupId: null,
    id: "c1",
    kind: "people",
    libraryVersionId: null,
    noteId: "n1",
    source: null,
    status: "applied",
    teamId: null,
    text: "New text",
    userScope: null,
    writtenBy: "dream",
    ...overrides,
  };
}

function viewOf(
  overrides: Partial<MemoryChange>,
  sides: { after: string | null; before: string | null }
): DreamChangeView {
  return { change: makeChange(overrides), ...sides };
}

const ROW_MARK = 'data-testid="dream-change"';

function rowsOf(html: string): string[] {
  return html.split(ROW_MARK).slice(1);
}

function render(changes: readonly DreamChangeView[]): string {
  return renderToStaticMarkup(<ChangesList changes={changes} />);
}

test("an empty list says the dream changed no notes", () => {
  const html = render([]);
  expect(html).toContain("This dream changed no notes.");
  expect(rowsOf(html)).toHaveLength(0);
});

test("each action gets its own lead", () => {
  const html = render([
    viewOf({ action: "add", id: "a" }, { after: "A", before: null }),
    viewOf({ action: "edit", id: "e" }, { after: "E", before: "old" }),
    viewOf({ action: "forget", id: "f" }, { after: null, before: "F" }),
    viewOf({ action: "merge", id: "m" }, { after: "M", before: "old" }),
  ]);
  const rows = rowsOf(html);
  expect(rows).toHaveLength(4);
  expect(rows[0]).toContain("Added a note");
  expect(rows[1]).toContain("Changed a note");
  expect(rows[2]).toContain("Dropped a note");
  expect(rows[3]).toContain("Merged notes");
});

test("a forget row in a merge group is folded into the merged note", () => {
  const html = render([
    viewOf(
      { action: "forget", groupId: "m1", id: "f1" },
      { after: null, before: "Folded text" }
    ),
  ]);
  expect(html).toContain("Folded into a merged note");
  expect(html).not.toContain("Dropped a note");
});

test("a held row says it waits for approval", () => {
  const html = render([
    viewOf({ action: "add", status: "held" }, { after: "A", before: null }),
  ]);
  expect(rowsOf(html)[0]).toContain("Held for your approval.");
  expect(rowsOf(html)[0]).not.toContain("Undone.");
});

test("an undone row says it was undone", () => {
  const html = render([
    viewOf({ action: "edit", status: "undone" }, { after: "A", before: "B" }),
  ]);
  expect(rowsOf(html)[0]).toContain("Undone.");
  expect(rowsOf(html)[0]).not.toContain("Held for your approval.");
});

test("an edit shows the before and after text with labels", () => {
  const [row] = rowsOf(
    render([
      viewOf({ action: "edit" }, { after: "New one", before: "Old one" }),
    ])
  );
  expect(row).toContain(">Before<");
  expect(row).toContain(">Old one<");
  expect(row).toContain(">After<");
  expect(row).toContain(">New one<");
  expect((row ?? "").indexOf("Old one")).toBeLessThan(
    (row ?? "").indexOf("New one")
  );
});

test("an edit with no before text shows only the after text", () => {
  const [row] = rowsOf(
    render([viewOf({ action: "edit" }, { after: "New one", before: null })])
  );
  expect(row).not.toContain(">Before<");
  expect(row).toContain(">After<");
  expect(row).toContain(">New one<");
});

test("SeeChanges renders only the closed button by default", () => {
  const html = renderToStaticMarkup(<SeeChanges runId="run-1" />);
  expect(html).toContain(">See changes<");
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain(ROW_MARK);
  expect(html).not.toContain("Loading the changes.");
});
