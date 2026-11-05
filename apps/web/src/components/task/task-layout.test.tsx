import { expect, test } from "bun:test";
import { file } from "bun";
import { renderToStaticMarkup } from "react-dom/server";
import { isTaskLayout } from "#/hooks/use-task-layout.ts";
import { canStop } from "./task-logic.ts";
import { RequestBanner, TaskTabs, tabFocusIndex } from "./task-tabs.tsx";
import {
  earlierRunsLabel,
  runPickerStatus,
  sessionRuns,
} from "./thread-runs.tsx";

const noop = () => undefined;

test("only the task route gets the full height layout", () => {
  expect(isTaskLayout(["/_app", "/_app/tasks/$runId"])).toBe(true);
  expect(isTaskLayout(["/_app", "/_app/desk"])).toBe(false);
});

test("tabs use manual activation and a roving tabindex", () => {
  const html = renderToStaticMarkup(
    <TaskTabs
      computer={false}
      conflict={false}
      files={0}
      log={2}
      mail={null}
      onSelect={noop}
      pending={false}
      selected="conversation"
    />
  );
  expect(html).toContain('role="tablist"');
  expect(html).toContain('aria-controls="task-panel-files"');
  expect(html.match(/tabindex="0"/g)).toHaveLength(1);
  expect(html).toContain("Files");
  expect(html).not.toContain(">Mail");
  expect(tabFocusIndex("ArrowRight", 2, 3)).toBe(0);
  expect(tabFocusIndex("ArrowLeft", 0, 3)).toBe(2);
  expect(tabFocusIndex("Home", 2, 3)).toBe(0);
  expect(tabFocusIndex("End", 0, 3)).toBe(2);
  expect(tabFocusIndex("Enter", 0, 3)).toBe(null);
});

test("request banner has one action and hides on conversation and takeover computer", () => {
  const render = (
    selected: "files" | "conversation" | "computer",
    kind: "approval" | "question" | "takeover"
  ) =>
    renderToStaticMarkup(
      <RequestBanner kind={kind} onReview={noop} selected={selected} />
    );
  expect(render("files", "approval")).toContain("Review approval");
  expect(render("files", "question")).toContain("Answer question");
  expect(render("files", "takeover")).toContain("Take over");
  expect(render("conversation", "question")).toBe("");
  expect(render("computer", "takeover")).toBe("");
});

test("run picker orders every run and summarizes only uniform earlier statuses", () => {
  const runs = [
    { createdAt: "", id: "2", status: "done" as const, title: "Second" },
    { createdAt: "", id: "1", status: "failed" as const, title: "First" },
  ];
  expect(runPickerStatus("waiting")).toBe("Needs you");
  expect(
    sessionRuns(runs, {
      createdAt: "",
      id: "3",
      status: "running",
      title: "Third",
    }).map((r) => r.id)
  ).toEqual(["1", "2", "3"]);
  expect(earlierRunsLabel(runs)).toBe("2 earlier runs in this thread");
  expect(
    earlierRunsLabel([
      runs[0] as (typeof runs)[number],
      runs[0] as (typeof runs)[number],
      runs[0] as (typeof runs)[number],
    ])
  ).toBe("3 earlier runs in this thread · all done");
});

test("Stop is only available for active runs", () => {
  for (const status of [
    "done",
    "failed",
    "cancelled",
    "interrupted",
  ] as const) {
    expect(canStop(status)).toBe(false);
  }
  for (const status of ["queued", "running", "waiting"] as const) {
    expect(canStop(status)).toBe(true);
  }
});

test("assistant text and the conversation viewport have no clipping limit", async () => {
  const assistant = await file(
    new URL("../thread/assistant-message-container.tsx", import.meta.url)
  ).text();
  const thread = await file(
    new URL("../thread/thread-container.tsx", import.meta.url)
  ).text();
  expect(assistant).not.toContain("line-clamp");
  expect(thread).not.toContain("max-h-[60dvh]");
});
