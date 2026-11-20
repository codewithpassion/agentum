import { expect, mock, test } from "bun:test";
import { fixtureTabProps, renderInRoom } from "../test-fixtures.tsx";
import type { NowPanelViewProps } from "./index.tsx";
import { makeListItem, makeTask } from "./now-fixtures.ts";
import { latestStep, liveHelpers } from "./now-logic.ts";

// Learned this week reads Clerk's auth state, which needs a provider.
mock.module("@clerk/tanstack-react-start", () => ({
  useAuth: () => ({ orgRole: "org:admin", userId: "user_1" }),
}));

const { NowPanel, NowPanelView } = await import("./index.tsx");

const noop = (): void => undefined;

const viewProps = (
  overrides: Partial<NowPanelViewProps> = {}
): NowPanelViewProps => {
  const task = makeTask();
  return {
    agentName: "Sorter",
    busyHelperIds: [],
    error: null,
    helpers: liveHelpers(task),
    learned: null,
    machineId: null,
    madeToday: { artifacts: [], files: [] },
    onStopHelper: noop,
    run: makeListItem({}),
    step: latestStep(task),
    takeover: null,
    ...overrides,
  };
};

test("a run with two subagents shows the step line and both helpers", () => {
  const html = renderInRoom(<NowPanelView {...viewProps()} />);
  expect(html).toContain("Search invoices");
  expect(html).toContain('href="/tasks/run_1"');
  expect(html.split('data-testid="helper-chip"')).toHaveLength(3);
  expect(html).toContain("Stop Read the bank export");
  expect(html).toContain("Stop Draft the reminders");
  expect(html).not.toContain("Count the receipts");
});

test("an idle agent shows only that nothing is running", () => {
  const html = renderInRoom(
    <NowPanelView {...viewProps({ helpers: [], run: null, step: null })} />
  );
  expect(html).toContain("Nothing is running.");
  expect(html).not.toContain("now-helpers");
  expect(html).not.toContain("now-screen");
  expect(html).not.toContain("now-made-today");
  expect(html).not.toContain("now-learned");
});

test("the screen card appears only when the agent has a computer", () => {
  const without = renderInRoom(<NowPanelView {...viewProps()} />);
  const withScreen = renderInRoom(
    <NowPanelView {...viewProps({ machineId: "machine_1" })} />
  );
  expect(without).not.toContain("now-screen");
  expect(withScreen).toContain("Watch");
  expect(withScreen).toContain("Take over");
});

test("made today lists files and the learned slot shows what it is given", () => {
  const html = renderInRoom(
    <NowPanelView
      {...viewProps({
        learned: <p>Learned slot</p>,
        madeToday: {
          artifacts: [],
          files: [
            {
              path: "agents/sorter/tasks/run_1/report.md",
              runId: "run_1",
              size: 1200,
            },
          ],
        },
      })}
    />
  );
  expect(html).toContain("report.md");
  expect(html).toContain("Learned slot");
});

test("an archived agent gets no panel", () => {
  const props = fixtureTabProps();
  props.room.agent.status = "archived";
  expect(renderInRoom(<NowPanel nowMs={null} room={props.room} />)).toBe("");
});

test("an active agent with no task yet shows the quiet panel", () => {
  const props = fixtureTabProps();
  const html = renderInRoom(<NowPanel nowMs={null} room={props.room} />);
  expect(html).toContain("Nothing is running.");
});
