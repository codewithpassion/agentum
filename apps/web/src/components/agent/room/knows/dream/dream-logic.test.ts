import { expect, test } from "bun:test";
import type { DreamCounts, DreamRun, DreamRunStatus } from "@repo/db/shared";
import {
  canUndoRun,
  countsSentence,
  dreamCardState,
  dreamTitle,
  earlierRuns,
  questionsSentence,
  RUN_STATUS_LABELS,
  SCHEDULE_OPTIONS,
  sortRuns,
} from "./dream-logic.ts";

// Built from local parts, because "today", "yesterday" and the 6 o'clock cut-off are local.
const NOW_MS = new Date(2026, 10, 20, 12, 0, 0).getTime();

const ZERO_COUNTS: DreamCounts = {
  added: 0,
  dropped: 0,
  merged: 0,
  questions: 0,
};

function makeRun(overrides: Partial<DreamRun>): DreamRun {
  return {
    agentId: "agent-1",
    baseVersion: [],
    counts: ZERO_COUNTS,
    diary: "",
    error: null,
    finishedAt: null,
    heldChanges: 0,
    id: "run-1",
    resultVersion: null,
    since: null,
    startedAt: new Date(2026, 10, 19, 3, 0, 0).toISOString(),
    status: "done",
    teamId: null,
    usage: null,
    ...overrides,
  };
}

function idsOf(runs: readonly DreamRun[]): string[] {
  return runs.map((run) => run.id);
}

const ALL_STATUSES: readonly DreamRunStatus[] = [
  "running",
  "done",
  "skipped",
  "failed",
  "undone",
];

test("sortRuns puts the newest start first", () => {
  const older = makeRun({
    id: "a",
    startedAt: new Date(2026, 10, 18, 3, 0).toISOString(),
  });
  const newest = makeRun({
    id: "b",
    startedAt: new Date(2026, 10, 20, 3, 0).toISOString(),
  });
  const middle = makeRun({
    id: "c",
    startedAt: new Date(2026, 10, 19, 3, 0).toISOString(),
  });
  expect(idsOf(sortRuns([older, newest, middle]))).toEqual(["b", "c", "a"]);
});

test("sortRuns breaks equal start times by id, descending", () => {
  const startedAt = new Date(2026, 10, 19, 3, 0).toISOString();
  const runs = [
    makeRun({ id: "run-a", startedAt }),
    makeRun({ id: "run-c", startedAt }),
    makeRun({ id: "run-b", startedAt }),
  ];
  expect(idsOf(sortRuns(runs))).toEqual(["run-c", "run-b", "run-a"]);
});

test("sortRuns returns a new array and leaves the input alone", () => {
  const runs = [
    makeRun({ id: "a", startedAt: new Date(2026, 10, 18, 3).toISOString() }),
    makeRun({ id: "b", startedAt: new Date(2026, 10, 19, 3).toISOString() }),
  ];
  const sorted = sortRuns(runs);
  expect(sorted).not.toBe(runs);
  expect(idsOf(runs)).toEqual(["a", "b"]);
});

test("sortRuns of nothing is nothing", () => {
  expect(sortRuns([])).toEqual([]);
});

test("dreamCardState with no runs is none", () => {
  expect(dreamCardState([])).toEqual({ kind: "none" });
});

test("dreamCardState maps running, skipped, failed and undone to their own kind", () => {
  for (const status of ["running", "skipped", "failed", "undone"] as const) {
    const run = makeRun({ id: status, status });
    expect(dreamCardState([run])).toEqual({ kind: status, run });
  }
});

test("dreamCardState of a done run carries its question count", () => {
  const run = makeRun({
    counts: { added: 1, dropped: 0, merged: 0, questions: 3 },
    status: "done",
  });
  expect(dreamCardState([run])).toEqual({
    kind: "done",
    questions: 3,
    run,
  });
});

test("dreamCardState of a done run with held changes is held", () => {
  const run = makeRun({
    counts: { added: 1, dropped: 0, merged: 0, questions: 0 },
    heldChanges: 2,
    status: "done",
  });
  expect(dreamCardState([run])).toEqual({ kind: "held", run });
});

test("dreamCardState of a done run with no held changes is done", () => {
  const run = makeRun({
    counts: { added: 1, dropped: 0, merged: 0, questions: 0 },
    heldChanges: 0,
    status: "done",
  });
  expect(dreamCardState([run])).toEqual({
    kind: "done",
    questions: 0,
    run,
  });
});

test("dreamCardState reads only the newest run", () => {
  const older = makeRun({
    id: "old",
    startedAt: new Date(2026, 10, 18, 3).toISOString(),
    status: "done",
  });
  const newer = makeRun({
    id: "new",
    startedAt: new Date(2026, 10, 19, 3).toISOString(),
    status: "failed",
  });
  expect(dreamCardState([older, newer])).toEqual({
    kind: "failed",
    run: newer,
  });
  expect(dreamCardState([newer, older])).toEqual({
    kind: "failed",
    run: newer,
  });
});

test("earlierRuns leaves out only the newest run", () => {
  const oldest = makeRun({
    id: "a",
    startedAt: new Date(2026, 10, 17, 3).toISOString(),
  });
  const middle = makeRun({
    id: "b",
    startedAt: new Date(2026, 10, 18, 3).toISOString(),
  });
  const newest = makeRun({
    id: "c",
    startedAt: new Date(2026, 10, 19, 3).toISOString(),
  });
  expect(idsOf(earlierRuns([oldest, newest, middle]))).toEqual(["b", "a"]);
});

test("earlierRuns of zero or one run is empty", () => {
  expect(earlierRuns([])).toEqual([]);
  expect(earlierRuns([makeRun({ id: "only" })])).toEqual([]);
});

test("countsSentence names every non-zero part with a plural noun", () => {
  expect(
    countsSentence({ added: 3, dropped: 4, merged: 2, questions: 0 })
  ).toBe("Added 3 notes, merged 2, dropped 4.");
});

test("countsSentence says note in the singular for one added note", () => {
  expect(
    countsSentence({ added: 1, dropped: 1, merged: 1, questions: 0 })
  ).toBe("Added 1 note, merged 1, dropped 1.");
});

test("countsSentence leaves out zero parts", () => {
  expect(
    countsSentence({ added: 0, dropped: 4, merged: 2, questions: 0 })
  ).toBe("Merged 2, dropped 4.");
  expect(
    countsSentence({ added: 2, dropped: 0, merged: 0, questions: 0 })
  ).toBe("Added 2 notes.");
  expect(
    countsSentence({ added: 0, dropped: 1, merged: 0, questions: 0 })
  ).toBe("Dropped 1.");
});

test("countsSentence says Nothing changed when added, merged and dropped are all zero", () => {
  expect(
    countsSentence({ added: 0, dropped: 0, merged: 0, questions: 0 })
  ).toBe("Nothing changed.");
});

test("countsSentence never mentions questions", () => {
  expect(
    countsSentence({ added: 0, dropped: 0, merged: 0, questions: 5 })
  ).toBe("Nothing changed.");
  expect(
    countsSentence({ added: 1, dropped: 0, merged: 0, questions: 2 })
  ).toBe("Added 1 note.");
});

test("questionsSentence is null for no questions", () => {
  expect(questionsSentence(0)).toBeNull();
});

test("questionsSentence says One question for one", () => {
  expect(questionsSentence(1)).toBe("It asked you one question.");
});

test("questionsSentence counts more than one", () => {
  expect(questionsSentence(2)).toBe("It asked you 2 questions.");
  expect(questionsSentence(10)).toBe("It asked you 10 questions.");
});

test("dreamTitle is Last night's dream for a start before 6 on the same day", () => {
  expect(dreamTitle(new Date(2026, 10, 20, 3, 0).toISOString(), NOW_MS)).toBe(
    "Last night's dream"
  );
  expect(dreamTitle(new Date(2026, 10, 20, 5, 59).toISOString(), NOW_MS)).toBe(
    "Last night's dream"
  );
});

test("dreamTitle is Today's dream for a start at or after 6 on the same day", () => {
  expect(dreamTitle(new Date(2026, 10, 20, 6, 0).toISOString(), NOW_MS)).toBe(
    "Today's dream"
  );
  expect(dreamTitle(new Date(2026, 10, 20, 9, 30).toISOString(), NOW_MS)).toBe(
    "Today's dream"
  );
});

test("dreamTitle is Yesterday's dream for the day before, whatever the hour", () => {
  expect(dreamTitle(new Date(2026, 10, 19, 3, 0).toISOString(), NOW_MS)).toBe(
    "Yesterday's dream"
  );
  expect(dreamTitle(new Date(2026, 10, 19, 23, 0).toISOString(), NOW_MS)).toBe(
    "Yesterday's dream"
  );
});

test("dreamTitle counts local days across midnight", () => {
  const justAfterMidnight = new Date(2026, 10, 20, 0, 30).getTime();
  expect(
    dreamTitle(new Date(2026, 10, 19, 23, 50).toISOString(), justAfterMidnight)
  ).toBe("Yesterday's dream");
  expect(
    dreamTitle(new Date(2026, 10, 20, 0, 10).toISOString(), justAfterMidnight)
  ).toBe("Last night's dream");
});

test("dreamTitle gives the day count for older dreams", () => {
  expect(dreamTitle(new Date(2026, 10, 18, 3, 0).toISOString(), NOW_MS)).toBe(
    "Dream from 2 days ago"
  );
  expect(dreamTitle(new Date(2026, 10, 11, 3, 0).toISOString(), NOW_MS)).toBe(
    "Dream from 9 days ago"
  );
});

test("canUndoRun is true only for a done run that changed notes", () => {
  const changed = { added: 1, dropped: 0, merged: 0, questions: 0 };
  for (const status of ALL_STATUSES) {
    expect(
      canUndoRun(
        makeRun({ counts: changed, resultVersion: "version-1", status })
      )
    ).toBe(status === "done");
  }
  expect(
    canUndoRun(makeRun({ resultVersion: "version-1", status: "done" }))
  ).toBe(false);
  expect(
    canUndoRun(
      makeRun({
        counts: { added: 0, dropped: 0, merged: 0, questions: 3 },
        status: "done",
      })
    )
  ).toBe(false);
});

test("canUndoRun is false for a held run, whose changes were never written", () => {
  const changed = { added: 1, dropped: 0, merged: 0, questions: 0 };
  expect(
    canUndoRun(
      makeRun({
        counts: changed,
        heldChanges: 2,
        resultVersion: "version-1",
        status: "done",
      })
    )
  ).toBe(false);
});

test("canUndoRun is false for a run with no result version", () => {
  const changed = { added: 1, dropped: 0, merged: 0, questions: 0 };
  expect(
    canUndoRun(
      makeRun({ counts: changed, resultVersion: null, status: "done" })
    )
  ).toBe(false);
});

test("RUN_STATUS_LABELS names every status in plain words", () => {
  expect(RUN_STATUS_LABELS).toEqual({
    done: "Done",
    failed: "Failed",
    running: "Running",
    skipped: "Skipped",
    undone: "Undone",
  });
});

test("SCHEDULE_OPTIONS lists nightly, weekly and off in that order", () => {
  expect(SCHEDULE_OPTIONS).toEqual([
    {
      hint: "Dreams at 2 in the morning, every day.",
      label: "Nightly",
      value: "nightly",
    },
    {
      hint: "Dreams at 2 in the morning, once a week.",
      label: "Weekly",
      value: "weekly",
    },
    {
      hint: "Never dreams on its own. You can still use Dream now.",
      label: "Off",
      value: "off",
    },
  ]);
});
