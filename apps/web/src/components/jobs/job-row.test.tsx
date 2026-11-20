import { expect, test } from "bun:test";
import type { JobSentence } from "@repo/db/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { JobRow } from "./job-row.tsx";

const NOW_MS = Date.parse("2026-11-20T12:00:00Z");
const TWO_HOURS_AGO = "2026-11-20T10:00:00Z";

const routine: JobSentence = {
  agent: { id: "agent_1", name: "Sorter" },
  asksBefore: null,
  deliversTo: "the team channel",
  does: "Sort the new invoices",
  enabled: true,
  id: "routine_1",
  lastRunAt: TWO_HOURS_AGO,
  lastRunOk: true,
  nextRunAt: null,
  source: "routine",
  when: "Every weekday at 9:00",
};

const noop = (): void => undefined;

const render = (
  job: JobSentence,
  overrides: Partial<{
    showAgent: boolean;
    readOnly: boolean;
    busy: boolean;
  }> = {}
): string =>
  renderToStaticMarkup(
    <ul>
      <JobRow
        busy={overrides.busy ?? false}
        job={job}
        nowMs={NOW_MS}
        onEdit={noop}
        onPause={noop}
        onRunNow={noop}
        readOnly={overrides.readOnly ?? false}
        showAgent={overrides.showAgent ?? false}
      />
    </ul>
  );

test("a routine job renders its when and does chips, its last result and the Pause, Edit and Run now buttons", () => {
  const html = render(routine);
  expect(html).toContain('data-chip="when"');
  expect(html).toContain("Every weekday at 9:00");
  expect(html).toContain('data-chip="does"');
  expect(html).toContain("Sort the new invoices");
  expect(html).toContain("Last run ok, about 2 hours ago");
  expect(html).toContain('aria-label="Pause job: Sort the new invoices"');
  expect(html).toContain('aria-label="Edit job: Sort the new invoices"');
  expect(html).toContain('aria-label="Run job now: Sort the new invoices"');
  expect(html).not.toContain("Paused");
});

test("a paused job shows the Paused chip, dims the row and offers Resume", () => {
  const html = render({ ...routine, enabled: false });
  expect(html).toContain('data-chip="paused"');
  expect(html).toContain("Paused");
  expect(html).toContain(
    'class="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card p-3 opacity-70"'
  );
  expect(html).toContain('aria-label="Resume job: Sort the new invoices"');
  expect(html).not.toContain("Pause job:");
});

test("a slack job has Edit but no Pause and no Run now", () => {
  const html = render({ ...routine, source: "slack" });
  expect(html).toContain('aria-label="Edit job: Sort the new invoices"');
  expect(html).not.toContain("Pause job:");
  expect(html).not.toContain("Resume job:");
  expect(html).not.toContain("Run job now:");
});

test("an http job has Pause but no Run now", () => {
  const html = render({ ...routine, source: "http" });
  expect(html).toContain('aria-label="Pause job: Sort the new invoices"');
  expect(html).not.toContain("Run job now:");
});

test("showAgent true shows the agent name chip and false does not", () => {
  expect(render(routine, { showAgent: true })).toContain('data-chip="agent"');
  expect(render(routine, { showAgent: true })).toContain("Sorter");
  expect(render(routine, { showAgent: false })).not.toContain(
    'data-chip="agent"'
  );
});

test("readOnly renders no buttons", () => {
  const html = render(routine, { readOnly: true });
  expect(html).toContain("Sort the new invoices");
  expect(html).not.toContain("<button");
});

test("a failed last run renders the text-destructive class", () => {
  const html = render({ ...routine, lastRunOk: false });
  expect(html).toContain("Last run failed");
  expect(html).toContain("text-destructive");
});

test("a job that has never run renders Not run yet", () => {
  const html = render({ ...routine, lastRunAt: null, lastRunOk: null });
  expect(html).toContain("Not run yet");
  expect(html).not.toContain("text-destructive");
});
