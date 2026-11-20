import { expect, test } from "bun:test";
import type { DreamRun } from "@repo/db/shared";
import { Window } from "happy-dom";
import type { ReactElement } from "react";
import { renderInRoom } from "../../test-fixtures.tsx";
import { EarlierDreams } from "./earlier-dreams.tsx";

const DAY_MS = 86_400_000;
const NOW = new Date(2026, 10, 20, 12, 0).getTime();

const run = (overrides: Partial<DreamRun> = {}): DreamRun => ({
  agentId: "agent_1",
  baseVersion: [],
  counts: { added: 0, dropped: 0, merged: 0, questions: 0 },
  diary: "",
  error: null,
  finishedAt: null,
  heldChanges: 0,
  id: "run_1",
  resultVersion: null,
  since: null,
  startedAt: new Date(NOW - 3_600_000).toISOString(),
  status: "done",
  teamId: null,
  usage: null,
  ...overrides,
});

const render = (element: ReactElement) => {
  const { document } = new Window();
  document.body.innerHTML = renderInRoom(element);
  return document;
};

test("with only one dream there are no earlier dreams to show", () => {
  expect(renderInRoom(<EarlierDreams nowMs={NOW} runs={[run()]} />)).toBe("");
});

test("three dreams show every run except the newest, with its when and status", () => {
  const newest = run({
    counts: { added: 1, dropped: 0, merged: 0, questions: 0 },
    id: "run_new",
    status: "done",
  });
  const yesterday = run({
    diary: "A quiet day.",
    id: "run_yesterday",
    startedAt: new Date(NOW - DAY_MS).toISOString(),
    status: "skipped",
  });
  const threeDaysAgo = run({
    error: "Model timed out.",
    id: "run_old",
    startedAt: new Date(NOW - 3 * DAY_MS).toISOString(),
    status: "failed",
  });
  const document = render(
    <EarlierDreams nowMs={NOW} runs={[threeDaysAgo, newest, yesterday]} />
  );

  const rows = Array.from(
    document.querySelectorAll('[data-testid="earlier-dream"]')
  );
  expect(rows).toHaveLength(2);
  expect(rows[0]?.textContent).toContain("Yesterday");
  expect(rows[0]?.textContent).toContain("A quiet day.");
  expect(rows[1]?.textContent).toContain("3 days ago");
  expect(rows[1]?.textContent).toContain("Model timed out.");
  expect(document.body.textContent).not.toContain("Added 1 note.");
  expect(document.querySelector("h3")?.textContent).toBe("Earlier dreams");
});

test("each earlier dream shows its status as a badge", () => {
  const document = render(
    <EarlierDreams
      nowMs={NOW}
      runs={[
        run({ id: "run_new" }),
        run({
          id: "run_skip",
          startedAt: new Date(NOW - DAY_MS).toISOString(),
          status: "skipped",
        }),
        run({
          id: "run_fail",
          startedAt: new Date(NOW - 2 * DAY_MS).toISOString(),
          status: "failed",
        }),
        run({
          id: "run_undo",
          startedAt: new Date(NOW - 3 * DAY_MS).toISOString(),
          status: "undone",
        }),
      ]}
    />
  );
  const badges = Array.from(
    document.querySelectorAll(
      '[data-testid="earlier-dream"] [data-slot="badge"]'
    )
  ).map((badge) => badge.textContent);
  expect(badges).toEqual(["Skipped", "Failed", "Undone"]);
});
