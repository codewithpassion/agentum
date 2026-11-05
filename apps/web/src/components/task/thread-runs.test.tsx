import { expect, test } from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { RunPicker } from "./thread-runs.tsx";

test("run picker labels the current run of the session", async () => {
  const rootRoute = createRootRoute({
    component: () => (
      <RunPicker
        runId="run-1"
        runs={[
          {
            createdAt: "2026-10-27T00:00:00.000Z",
            id: "run-1",
            status: "done",
            title: "Invoice",
          },
          {
            createdAt: "2026-10-28T00:00:00.000Z",
            id: "run-2",
            status: "failed",
            title: "Second",
          },
        ]}
      />
    ),
  });
  const taskRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/tasks/$runId",
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: rootRoute.addChildren([taskRoute]),
  });
  await router.load();
  const html = renderToStaticMarkup(<RouterProvider router={router} />);
  expect(html).toContain("Run 1 of 2");
  expect(html).not.toContain("Inbound mail");
});
