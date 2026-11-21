import { expect, test } from "bun:test";
import type { DreamRun, MemoryNote } from "@repo/db/shared";
import { Window } from "happy-dom";
import type { DreamApi } from "../agent/room/knows/dream/use-dream.ts";
import { renderInRoom } from "../agent/room/test-fixtures.tsx";
import { TeamMemory, type TeamMemoryProps } from "./team-memory.tsx";

const HOUR_MS = 3_600_000;
/** Noon on 20 Nov in the viewer's time zone, so an hour earlier is still today. */
const NOW = new Date(2026, 10, 20, 12, 0).getTime();
const noop = (): void => undefined;

const teamRun = (overrides: Partial<DreamRun> = {}): DreamRun => ({
  agentId: null,
  baseVersion: [],
  counts: { added: 1, dropped: 3, merged: 0, questions: 0 },
  diary: "Added 1 team note and removed 3 member copies.",
  error: null,
  finishedAt: null,
  heldChanges: 0,
  id: "run_1",
  openQuestions: 0,
  resultVersion: "v1",
  since: null,
  startedAt: new Date(NOW - HOUR_MS).toISOString(),
  status: "done",
  teamId: "team_1",
  usage: null,
  ...overrides,
});

const note = (overrides: Partial<MemoryNote> = {}): MemoryNote => ({
  date: "2026-11-19",
  id: "n1",
  kind: "places",
  source: null,
  text: "Pipeline numbers live in the Sales sheet",
  userScope: null,
  writtenBy: "dream",
  ...overrides,
});

const dreamApi = (overrides: Partial<DreamApi> = {}): DreamApi => ({
  decide: noop,
  error: undefined,
  pending: null,
  runNow: noop,
  runs: [],
  undo: noop,
  ...overrides,
});

const render = (overrides: Partial<TeamMemoryProps> = {}) => {
  const { document } = new Window();
  document.body.innerHTML = renderInRoom(
    <TeamMemory
      dream={dreamApi()}
      notes={[]}
      notesError={undefined}
      nowMs={NOW}
      teamName="Sales"
      {...overrides}
    />
  );
  return document;
};

const buttonNames = (document: ReturnType<typeof render>): string[] =>
  Array.from(document.querySelectorAll("button")).map((button) =>
    (button.textContent ?? "").trim()
  );

test("a team that has not dreamed says so, offers Dream now and no schedule, and has no notes yet", () => {
  const document = render();
  const text = document.body.textContent ?? "";
  expect(text).toContain("Sales has not dreamed yet.");
  expect(text).toContain("The team has no shared notes yet.");
  expect(buttonNames(document)).toEqual(["Dream now"]);
  expect(document.querySelector('[role="radio"]')).toBeNull();
});

test("the latest team dream shows its diary, with Undo this night and the team's notes", () => {
  const document = render({
    dream: dreamApi({ runs: [teamRun()] }),
    notes: [note()],
  });
  const text = document.body.textContent ?? "";
  expect(text).toContain("Added 1 team note and removed 3 member copies.");
  expect(text).toContain("Pipeline numbers live in the Sales sheet");
  expect(buttonNames(document)).toContain("Undo this night");
  expect(buttonNames(document)).toContain("Dream now");
});

test("nothing renders before the dreams and the notes are read", () => {
  const document = render({
    dream: dreamApi({ runs: undefined }),
    notes: undefined,
  });
  expect(
    document.querySelector('[data-testid="team-memory"]')?.children.length
  ).toBe(0);
});

test("a failed read or a failed dream is shown as an alert", () => {
  const document = render({
    dream: dreamApi({ error: "The dream failed" }),
    notesError: "Could not read the notes",
  });
  const alerts = Array.from(document.querySelectorAll('[role="alert"]')).map(
    (alert) => alert.textContent
  );
  expect(alerts).toEqual(["The dream failed", "Could not read the notes"]);
});
