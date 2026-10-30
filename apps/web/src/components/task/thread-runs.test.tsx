import { expect, test } from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { ThreadRuns } from "./thread-runs.tsx";

test("thread runs list each run by its title, not its input text", async () => {
  const rootRoute = createRootRoute({
    component: () => (
      <ThreadRuns
        heading="Earlier in this thread"
        runs={[
          {
            createdAt: "2026-10-27T00:00:00.000Z",
            id: "run-1",
            status: "done",
            title: "Invoice",
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
  expect(html).toContain(">Invoice<");
  expect(html).not.toContain("Inbound mail");
});
