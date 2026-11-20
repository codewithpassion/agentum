import { expect, test } from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { TopBar } from "./top-bar.tsx";

const noop = () => undefined;

const anchorTags = (html: string): string[] => html.match(/<a\b[^>]*>/g) ?? [];

const anchorTo = (html: string, href: string): string | undefined =>
  anchorTags(html).find((tag) => tag.includes(`href="${href}"`));

const render = ({
  count = null,
  current = null,
  hasSpendPage = false,
  findShortcut = "Ctrl K",
}: {
  count?: number | null;
  current?: "Home" | "Files" | "Spend" | null;
  hasSpendPage?: boolean;
  findShortcut?: string;
} = {}) => {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute(),
  });
  return renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <TopBar
        assistant={<span>assistant</span>}
        count={count}
        current={current}
        findShortcut={findShortcut}
        hasSpendPage={hasSpendPage}
        menuAccount={<span>account</span>}
        menuOpen={false}
        onMenuOpenChange={noop}
        onOpenFind={noop}
        onOpenNeedsYou={noop}
        theme={<span>theme</span>}
        user={<span>user</span>}
        workspace={<span>workspace</span>}
      />
    </RouterContextProvider>
  );
};

test("the bar links to Home, Files and New agent, and Spend only once its page exists", () => {
  const html = render();
  expect(anchorTo(html, "/home")).toBeDefined();
  expect(anchorTo(html, "/library")).toBeDefined();
  expect(anchorTo(html, "/agents/new")).toBeDefined();
  expect(anchorTo(html, "/spend")).toBeUndefined();
  expect(anchorTo(render({ hasSpendPage: true }), "/spend")).toBeDefined();
});

test("the Needs you button shows the count only when it is above zero", () => {
  expect(render({ count: null })).toContain('aria-label="Needs you"');
  expect(render({ count: 0 })).toContain('aria-label="Needs you"');
  const withThree = render({ count: 3 });
  expect(withThree).toContain('aria-label="Needs you, 3 waiting"');
  expect(withThree).toContain(">3</span>");
});

test("only the link for the current page is aria-current", () => {
  const html = render({ current: "Files" });
  expect(anchorTo(html, "/library")).toContain('aria-current="page"');
  expect(anchorTo(html, "/home")).not.toContain("aria-current");
  expect(anchorTo(html, "/agents/new")).not.toContain("aria-current");
});

test("the phone menu button is there and the find shortcut is shown", () => {
  const html = render({ findShortcut: "⌘K" });
  expect(html).toContain('aria-label="Menu"');
  expect(html).toContain("⌘K</kbd>");
});
