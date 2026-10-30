import { expect, test } from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { OpenQuestionsRow } from "./rail-questions.tsx";

const router = createRouter({
  history: createMemoryHistory({ initialEntries: ["/"] }),
  routeTree: createRootRoute(),
});

const render = (count: number) =>
  renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <OpenQuestionsRow count={count} />
    </RouterContextProvider>
  );

test("nothing renders when no question is open", () => {
  expect(render(0)).toBe("");
});

test("an open question links to Q&A with its count", () => {
  const html = render(2);
  expect(html).toContain('href="/qa"');
  expect(html).toContain("2 open questions");
});
