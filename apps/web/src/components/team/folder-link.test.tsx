import { expect, test } from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { FolderLink } from "./folder-link.tsx";

const router = createRouter({
  history: createMemoryHistory({ initialEntries: ["/"] }),
  routeTree: createRootRoute(),
});

const render = (folderPath: string | null) =>
  renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <FolderLink folderPath={folderPath} />
    </RouterContextProvider>
  );

test("a team with no folder says so", () => {
  const html = render(null);
  expect(html).toContain("This team has no shared folder.");
  expect(html).not.toContain("<a");
});

const FOLDER_HREF = /href="\/library\?dir=teams(%2F|\/)sales"/;

test("a folder shows its path with a trailing slash and links to the library", () => {
  const html = render("teams/sales");
  expect(html).toContain("teams/sales/");
  expect(html).toMatch(FOLDER_HREF);
  expect(html).toContain("Every agent in the team can read and write here.");
});
