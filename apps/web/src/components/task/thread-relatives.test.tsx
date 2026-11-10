import { expect, test } from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ThreadRelatives } from "./thread-relatives.tsx";

const render = (element: ReactElement) => {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/desk"] }),
    routeTree: createRootRoute(),
  });
  return renderToStaticMarkup(
    <RouterContextProvider router={router}>{element}</RouterContextProvider>
  );
};

test("a child links back to its parent, and a parent lists its children with status", () => {
  const child = render(
    <ThreadRelatives
      parent={{ id: "s-parent", title: "Plan the launch" }}
      subThreads={[]}
    />
  );
  expect(child).toContain("Started from");
  expect(child).toContain("Plan the launch");
  expect(child).toContain('href="/threads/s-parent"');

  const parent = render(
    <ThreadRelatives
      parent={null}
      subThreads={[
        {
          agentName: "Beta",
          id: "s-child",
          status: "running",
          title: "Draft the copy",
        },
      ]}
    />
  );
  expect(parent).toContain("Draft the copy");
  expect(parent).toContain("Beta, Running");
  expect(parent).not.toContain("Started from");
});

test("a thread with no relatives shows nothing", () => {
  expect(render(<ThreadRelatives parent={null} subThreads={[]} />)).toBe("");
});
