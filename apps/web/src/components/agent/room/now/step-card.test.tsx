import { expect, test } from "bun:test";
import { renderInRoom } from "../test-fixtures.tsx";
import { makeListItem, makeTask } from "./now-fixtures.ts";
import { latestStep } from "./now-logic.ts";
import { StepCard } from "./step-card.tsx";

test("with nothing running it says so", () => {
  const html = renderInRoom(<StepCard run={null} step={null} />);
  expect(html).toContain("Nothing is running.");
  expect(html).not.toContain('now-step"');
});

test("a running task shows its title, its latest step and a link to it", () => {
  const task = makeTask();
  const html = renderInRoom(
    <StepCard run={makeListItem({})} step={latestStep(task)} />
  );
  expect(html).toContain("Reconcile the invoices");
  expect(html).toContain("Search invoices");
  expect(html).toContain('href="/tasks/run_1"');
});

test("the line follows the receipt as steps arrive", () => {
  const first = latestStep(makeTask());
  const second = latestStep(
    makeTask({ events: [...makeTask().events.slice(0, 1)] })
  );
  const render = (step: typeof first) =>
    renderInRoom(<StepCard run={makeListItem({})} step={step} />);
  expect(render(first)).toContain("Search invoices");
  expect(render(second)).not.toContain("Search invoices");
});

test("a task whose steps are not read yet says it is starting", () => {
  const html = renderInRoom(<StepCard run={makeListItem({})} step={null} />);
  expect(html).toContain("Starting.");
});
