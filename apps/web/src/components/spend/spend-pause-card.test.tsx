import { expect, test } from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SpendPauseView,
  type SpendPauseViewProps,
} from "./spend-pause-card.tsx";

const router = createRouter({
  history: createMemoryHistory({ initialEntries: ["/"] }),
  routeTree: createRootRoute(),
});

const noop = () => undefined;
const DISABLED_RESUME = /<button[^>]*disabled[^>]*>Resume<\/button>/;
const DISABLED_RAISE = /<button[^>]*disabled[^>]*>Raise the limit<\/button>/;

const baseProps: SpendPauseViewProps = {
  busy: false,
  error: null,
  isAdmin: true,
  limitText: "The limit is $20 a week.",
  onRaiseChange: noop,
  onRaiseOpen: noop,
  onRaiseSubmit: noop,
  onResume: noop,
  raiseValue: "",
  raising: false,
  workspaceLimitText: null,
};

const render = (props: Partial<SpendPauseViewProps>) =>
  renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <SpendPauseView {...baseProps} {...props} />
    </RouterContextProvider>
  );

test("a paused agent shows its limit, Resume and Raise the limit", () => {
  const html = render({});
  expect(html).toContain("The limit is $20 a week.");
  expect(html).toContain(">Resume</button>");
  expect(html).toContain(">Raise the limit</button>");
  expect(html).not.toContain("spend-pause-raise");
});

test("raising the limit shows a dollar input and Raise and resume", () => {
  const html = render({ raiseValue: "25", raising: true });
  expect(html).toContain("New weekly limit in dollars</label>");
  expect(html).toContain('id="spend-pause-raise"');
  expect(html).toContain('value="25"');
  expect(html).toContain(">Raise and resume</button>");
  expect(html).not.toContain(">Raise the limit</button>");
});

test("busy disables the buttons", () => {
  const html = render({ busy: true });
  expect(html).toMatch(DISABLED_RESUME);
  expect(html).toMatch(DISABLED_RAISE);
});

test("an error reads as an alert", () => {
  expect(render({ error: "Nope" })).toContain('role="alert"');
  expect(render({})).not.toContain('role="alert"');
});

test("a pause from the workspace limit sends Raise to the workspace setting", () => {
  const html = render({
    workspaceLimitText: "The workspace limit of $50 a week is reached.",
  });
  expect(html).toContain("The workspace limit of $50 a week is reached.");
  expect(html).toContain(">Resume</button>");
  expect(html).toContain("Raise the workspace limit");
  expect(html).toContain('href="/settings/spend"');
  expect(html).not.toContain(">Raise the limit</button>");
});

test("a non-admin paused by the workspace limit gets no Resume, only the workspace link", () => {
  const html = render({
    isAdmin: false,
    workspaceLimitText: "The workspace limit of $50 a week is reached.",
  });
  expect(html).toContain("The workspace limit of $50 a week is reached.");
  expect(html).not.toContain(">Resume</button>");
  expect(html).toContain("Raise the workspace limit");
});
