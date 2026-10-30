import { expect, test } from "bun:test";
import type { RailCard } from "@repo/db/shared";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { ProblemBody } from "./problem-pane.tsx";

const router = createRouter({
  history: createMemoryHistory({ initialEntries: ["/"] }),
  routeTree: createRootRoute(),
});

const problem = (overrides: Partial<RailCard>): RailCard => ({
  agentId: "agent_1",
  agentName: "Alpha",
  at: "2026-10-31T01:00:00.000Z",
  detail: "",
  expiresAt: null,
  id: "card_1",
  kind: "problem",
  mail: null,
  passedOnBy: null,
  runId: "run_1",
  status: "Failed",
  threadId: null,
  title: "Something went wrong",
  ...overrides,
});

const noop = () => Promise.resolve();

const render = (card: RailCard) =>
  renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <ProblemBody card={card} onDismiss={noop} />
    </RouterContextProvider>
  );

test("a bounced mail says what happened in its detail", () => {
  const html = render(
    problem({ detail: "Mail to gone@example.net bounced", status: "Bounced" })
  );
  expect(html).toContain("Mail to gone@example.net bounced");
  expect(html).not.toContain("'s work");
});

test("a failed run says what happened in its detail", () => {
  const html = render(problem({ detail: "Alpha stopped before finishing" }));
  expect(html).toContain("Alpha stopped before finishing");
  expect(html).not.toContain("'s work");
});

test("the log is a link and Dismiss is the only outline button", () => {
  const html = render(problem({ detail: "Alpha stopped before finishing" }));
  expect(html).toContain(">Open the log</a>");
  expect(html).toContain(">Dismiss</button>");
  expect(html).not.toContain(">Open the log</button>");
});
