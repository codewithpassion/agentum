import { expect, test } from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { RailFooter } from "./rail.tsx";

const noop = () => undefined;

test("the rail footer links to Apps between Agents and Files", () => {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute(),
  });
  const html = renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <RailFooter onNavigate={noop} onOpenFind={noop} />
    </RouterContextProvider>
  );
  expect(html).toContain('href="/artifacts?kind=app">Apps</a>');
  expect(html.indexOf(">Agents</a>")).toBeLessThan(html.indexOf(">Apps</a>"));
  expect(html.indexOf(">Apps</a>")).toBeLessThan(html.indexOf(">Files</a>"));
  expect(html).toContain("grid-cols-4");
  expect(html).toContain(">Everything</button>");
});
