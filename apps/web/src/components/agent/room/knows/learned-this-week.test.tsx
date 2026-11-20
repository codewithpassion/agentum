import { expect, test } from "bun:test";
import type { MemoryChange } from "@repo/db/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { LearnedList } from "./learned-this-week.tsx";
import { NOTES_OWNER_ONLY } from "./notes-logic.ts";

// Built from local parts, because "today" and "yesterday" are local days.
const NOW_MS = new Date(2026, 10, 20, 12, 0, 0).getTime();
const TODAY_ISO = new Date(2026, 10, 20, 8, 0, 0).toISOString();
const YESTERDAY_ISO = new Date(2026, 10, 19, 20, 0, 0).toISOString();

function makeChange(overrides: Partial<MemoryChange>): MemoryChange {
  return {
    action: "add",
    agentId: "agent-1",
    createdAt: TODAY_ISO,
    decidedAt: null,
    decidedBy: null,
    dreamRunId: null,
    groupId: null,
    id: "c1",
    kind: "people",
    libraryVersionId: null,
    noteId: "n1",
    source: null,
    status: "applied",
    teamId: null,
    text: "Likes short emails",
    userScope: null,
    writtenBy: "person",
    ...overrides,
  };
}

const noop = (): void => undefined;

const ROW_MARK = 'data-testid="learned-row"';
const DISABLED_ATTR = 'disabled=""';
// renderToStaticMarkup escapes the apostrophe in the shared note text.
const OWNER_ONLY_MARKUP = NOTES_OWNER_ONLY.replace("'", "&#x27;");

function rowsOf(html: string): string[] {
  return html.split(ROW_MARK).slice(1);
}

test("an empty list renders nothing", () => {
  const html = renderToStaticMarkup(
    <LearnedList
      busyId={null}
      canChange={true}
      changes={[]}
      disabled={false}
      nowMs={NOW_MS}
      onUndo={noop}
    />
  );
  expect(html).toBe("");
});

test("each change gets a row with its sentence, day and Undo", () => {
  const changes = [
    makeChange({ action: "add", id: "c1", text: "Likes short emails" }),
    makeChange({
      action: "forget",
      createdAt: YESTERDAY_ISO,
      id: "c2",
      text: "Old address",
    }),
  ];
  const html = renderToStaticMarkup(
    <LearnedList
      busyId={null}
      canChange={true}
      changes={changes}
      disabled={false}
      nowMs={NOW_MS}
      onUndo={noop}
    />
  );
  const rows = rowsOf(html);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toContain("Remembered: Likes short emails");
  expect(rows[0]).toContain("today");
  expect(rows[1]).toContain("Forgot: Old address");
  expect(rows[1]).toContain("yesterday");
  expect(rows[0]).toContain(">Undo<");
  expect(rows[1]).toContain(">Undo<");
});

test("Undo is disabled on every row when disabled is set", () => {
  const changes = [
    makeChange({ id: "c1" }),
    makeChange({ id: "c2", text: "Other" }),
  ];
  const html = renderToStaticMarkup(
    <LearnedList
      busyId={null}
      canChange={true}
      changes={changes}
      disabled={true}
      nowMs={NOW_MS}
      onUndo={noop}
    />
  );
  const rows = rowsOf(html);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toContain(DISABLED_ATTR);
  expect(rows[1]).toContain(DISABLED_ATTR);
});

test("Undo is disabled only on the row whose id is busyId", () => {
  const changes = [
    makeChange({ id: "c1" }),
    makeChange({ id: "c2", text: "Other" }),
  ];
  const html = renderToStaticMarkup(
    <LearnedList
      busyId="c2"
      canChange={true}
      changes={changes}
      disabled={false}
      nowMs={NOW_MS}
      onUndo={noop}
    />
  );
  const rows = rowsOf(html);
  expect(rows).toHaveLength(2);
  expect(rows[0]).not.toContain(DISABLED_ATTR);
  expect(rows[1]).toContain(DISABLED_ATTR);
});

test("a non-owner sees no Undo on a shared change and the owner-only line", () => {
  const html = renderToStaticMarkup(
    <LearnedList
      busyId={null}
      canChange={false}
      changes={[makeChange({ id: "c1", userScope: null })]}
      disabled={false}
      nowMs={NOW_MS}
      onUndo={noop}
    />
  );
  const rows = rowsOf(html);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toContain("Remembered: Likes short emails");
  expect(rows[0]).not.toContain(">Undo<");
  expect(html).toContain(OWNER_ONLY_MARKUP);
});

test("a non-owner keeps Undo on private changes and sees no owner-only line when all are private", () => {
  const changes = [
    makeChange({ id: "c1", userScope: "user-dom" }),
    makeChange({ id: "c2", text: "Other", userScope: "user-dom" }),
  ];
  const html = renderToStaticMarkup(
    <LearnedList
      busyId={null}
      canChange={false}
      changes={changes}
      disabled={false}
      nowMs={NOW_MS}
      onUndo={noop}
    />
  );
  const rows = rowsOf(html);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toContain(">Undo<");
  expect(rows[1]).toContain(">Undo<");
  expect(html).not.toContain(OWNER_ONLY_MARKUP);
});

test("a non-owner gets Undo only on the private rows of a mixed list", () => {
  const changes = [
    makeChange({ id: "c1", userScope: "user-dom" }),
    makeChange({ id: "c2", text: "Shared fact", userScope: null }),
  ];
  const html = renderToStaticMarkup(
    <LearnedList
      busyId={null}
      canChange={false}
      changes={changes}
      disabled={false}
      nowMs={NOW_MS}
      onUndo={noop}
    />
  );
  const rows = rowsOf(html);
  expect(rows[0]).toContain(">Undo<");
  expect(rows[1]).not.toContain(">Undo<");
  expect(html).toContain(OWNER_ONLY_MARKUP);
});

test("an owner sees Undo on every row and no owner-only line", () => {
  const changes = [
    makeChange({ id: "c1", userScope: null }),
    makeChange({ id: "c2", text: "Other", userScope: "user-dom" }),
  ];
  const html = renderToStaticMarkup(
    <LearnedList
      busyId={null}
      canChange={true}
      changes={changes}
      disabled={false}
      nowMs={NOW_MS}
      onUndo={noop}
    />
  );
  const rows = rowsOf(html);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toContain(">Undo<");
  expect(rows[1]).toContain(">Undo<");
  expect(html).not.toContain(OWNER_ONLY_MARKUP);
});
