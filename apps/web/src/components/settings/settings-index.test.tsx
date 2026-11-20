import { expect, test } from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsIndex } from "./settings-index";
import { settingsNav } from "./settings-nav";

const noop = () => undefined;
const router = createRouter({
  history: createMemoryHistory({ initialEntries: ["/"] }),
  routeTree: createRootRoute(),
});

test("phone Settings index lists every nav group and Members", () => {
  const html = renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <SettingsIndex onMembers={noop} />
    </RouterContextProvider>
  );
  for (const group of settingsNav) {
    expect(html).toContain(group.label);
    for (const item of group.items) {
      expect(html).toContain(`href="${item.to}"`);
    }
  }
  expect(html).toContain("Workspace");
  expect(html).toContain("Members");
});
