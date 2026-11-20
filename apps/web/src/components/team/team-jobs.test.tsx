import { expect, test } from "bun:test";
import type { JobSentence } from "@repo/db/shared";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { TeamJobs } from "./team-jobs.tsx";

const router = createRouter({
  history: createMemoryHistory({ initialEntries: ["/"] }),
  routeTree: createRootRoute(),
});

const job = (overrides: Partial<JobSentence> = {}): JobSentence => ({
  agent: { id: "agent_ruby", name: "Ruby" },
  asksBefore: null,
  awaitingApproval: false,
  deliversTo: null,
  does: "sends the pipeline report",
  enabled: true,
  id: "routine_1",
  lastRunAt: null,
  lastRunOk: null,
  nextRunAt: null,
  source: "routine",
  when: "Every weekday at 9:00",
  ...overrides,
});

const render = (jobs: readonly JobSentence[]) =>
  renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <TeamJobs jobs={jobs} />
    </RouterContextProvider>
  );

test("an empty team says there are no standing jobs", () => {
  const html = render([]);
  expect(html).toContain("No standing jobs yet.");
  expect(html).not.toContain("<ul");
  expect(html).not.toContain('href="/jobs"');
});

test("a job row shows the agent name and when and does as one line", () => {
  const html = render([job()]);
  expect(html).toContain("<ul");
  expect(html).toContain("Ruby");
  expect(html).toContain("Every weekday at 9:00: sends the pipeline report");
});

test("a job with no does shows only when, with no colon", () => {
  const html = render([job({ does: "" })]);
  expect(html).toContain("Every weekday at 9:00</p>");
  expect(html).not.toContain("Every weekday at 9:00:");
});

test("the list ends with an All jobs link to /jobs", () => {
  const html = render([job()]);
  expect(html).toContain('href="/jobs"');
  expect(html).toContain("All jobs");
});

test("two jobs from the same routine id but different sources both render", () => {
  const html = render([
    job({ does: "first thing", id: "same", source: "routine" }),
    job({ does: "second thing", id: "same", source: "http" }),
  ]);
  expect(html).toContain("first thing");
  expect(html).toContain("second thing");
});
