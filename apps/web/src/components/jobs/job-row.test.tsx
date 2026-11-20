import { expect, test } from "bun:test";
import type { JobSentence } from "@repo/db/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { JobRow } from "./job-row.tsx";

const NOW_MS = Date.parse("2026-11-20T12:00:00Z");
const TWO_HOURS_AGO = "2026-11-20T10:00:00Z";

const routine: JobSentence = {
  agent: { id: "agent_1", name: "Sorter" },
  asksBefore: null,
  awaitingApproval: false,
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
    prompt: string | null;
  }> = {}
): string =>
  renderToStaticMarkup(
    <ul>
      <JobRow
        busy={overrides.busy ?? false}
        job={job}
        nowMs={NOW_MS}
        onApprove={noop}
        onEdit={noop}
        onPause={noop}
        onReject={noop}
        onRunNow={noop}
        prompt={overrides.prompt ?? null}
        readOnly={overrides.readOnly ?? false}
        showAgent={overrides.showAgent ?? false}
      />
    </ul>
  );

const proposal: JobSentence = {
  ...routine,
  awaitingApproval: true,
  enabled: false,
  id: "routine_proposed",
};

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

test("an awaiting proposal shows the Waiting for approval chip, not Paused, and is not dimmed", () => {
  const html = render(proposal);
  expect(html).toContain('data-chip="awaiting"');
  expect(html).toContain("Waiting for approval");
  expect(html).not.toContain('data-chip="paused"');
  expect(html).not.toContain("opacity-70");
});

test("an awaiting proposal offers Approve and Reject and no other action", () => {
  const html = render(proposal);
  expect(html).toContain('aria-label="Approve job: Sort the new invoices"');
  expect(html).toContain('aria-label="Reject job: Sort the new invoices"');
  expect(html).not.toContain("Resume job:");
  expect(html).not.toContain("Pause job:");
  expect(html).not.toContain("Run job now:");
  expect(html).not.toContain("Edit job:");
});

test("an awaiting proposal with a prompt shows it in a details element", () => {
  const html = render(proposal, { prompt: "Sort every invoice in the inbox" });
  expect(html).toContain("<details");
  expect(html).toContain("<summary");
  expect(html).toContain("See the full prompt");
  expect(html).toContain("<pre");
  expect(html).toContain("Sort every invoice in the inbox");
});

test("an awaiting proposal with no prompt renders no details", () => {
  const html = render(proposal, { prompt: null });
  expect(html).not.toContain("<details");
  expect(html).not.toContain("See the full prompt");
});

test("a readOnly awaiting proposal renders no buttons", () => {
  const html = render(proposal, { readOnly: true });
  expect(html).toContain("Waiting for approval");
  expect(html).not.toContain("<button");
});

test("an approved paused job still shows the Paused chip and Resume", () => {
  const html = render({ ...routine, enabled: false });
  expect(html).toContain('data-chip="paused"');
  expect(html).toContain('aria-label="Resume job: Sort the new invoices"');
  expect(html).not.toContain("Waiting for approval");
  expect(html).not.toContain("Approve job:");
});
