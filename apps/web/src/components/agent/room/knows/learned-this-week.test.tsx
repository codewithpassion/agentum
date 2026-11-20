import { expect, test } from "bun:test";
import type { MemoryChange } from "@repo/db/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { LearnedList } from "./learned-this-week.tsx";

const NOW_MS = Date.parse("2026-11-20T12:00:00.000Z");
const TODAY_ISO = "2026-11-20T08:00:00.000Z";
const YESTERDAY_ISO = "2026-11-19T20:00:00.000Z";

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
    text: "Likes short emails",
    userScope: null,
    writtenBy: "person",
    ...overrides,
  };
}

const noop = (): void => undefined;

const ROW_MARK = 'data-testid="learned-row"';
const DISABLED_ATTR = 'disabled=""';

function rowsOf(html: string): string[] {
  return html.split(ROW_MARK).slice(1);
}

test("an empty list renders nothing", () => {
  const html = renderToStaticMarkup(
    <LearnedList
      busyId={null}
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
