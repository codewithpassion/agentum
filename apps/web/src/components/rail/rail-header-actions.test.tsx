import { expect, test } from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import {
  APP_HEADER_ACTIONS_SLOT,
  HeaderActionsSlot,
} from "#/components/shell/header-menu-slot";
import { isBoardView, RailHeaderActions } from "./rail-header-actions.tsx";

const noop = () => undefined;

const render = (entry: string) => {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [entry] }),
    routeTree: createRootRoute(),
  });
  return renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <RailHeaderActions agents={[]} onNavigate={noop} onOpenFind={noop} />
    </RouterContextProvider>
  );
};

test("the header slot renders only inside the app shell", () => {
  expect(renderToStaticMarkup(<HeaderActionsSlot inAppShell />)).toContain(
    `id="${APP_HEADER_ACTIONS_SLOT}"`
  );
  expect(renderToStaticMarkup(<HeaderActionsSlot inAppShell={false} />)).toBe(
    ""
  );
});

test("Board links to the board view with its own name", () => {
  const html = render("/");
  expect(html).toContain('href="/desk?view=board"');
  expect(html).toContain('aria-label="Board"');
  expect(html).toContain('aria-label="Find"');
  expect(html).toContain('aria-label="New"');
});

test("Board is aria-current on the board view only", () => {
  expect(isBoardView({ pathname: "/desk", search: { view: "board" } })).toBe(
    true
  );
  expect(isBoardView({ pathname: "/desk", search: {} })).toBe(false);
  expect(isBoardView({ pathname: "/agents", search: { view: "board" } })).toBe(
    false
  );
});
