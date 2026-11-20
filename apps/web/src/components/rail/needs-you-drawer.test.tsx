import { expect, test } from "bun:test";
import type { RailCard, RailItem, RailView } from "@repo/db/shared";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { NeedsYouDrawer, NeedsYouList } from "./needs-you-drawer.tsx";
import type { NeedsYouState } from "./use-needs-you.ts";

const noop = () => undefined;
const router = createRouter({
  history: createMemoryHistory({ initialEntries: ["/"] }),
  routeTree: createRootRoute(),
});

const card = (id: string, title: string): RailCard => ({
  agentAvatar: { color: "slate", glyph: "?" },
  agentId: "",
  agentName: "",
  at: "2026-11-20T09:00:00.000Z",
  detail: "",
  expiresAt: null,
  id,
  kind: "question",
  mail: null,
  passedOnBy: null,
  runId: null,
  status: "Asks you",
  threadId: null,
  title,
});

const item = (id: string, title: string): RailItem => ({
  assigneeName: null,
  assigneeUserId: null,
  cards: [card(id, title)],
  dueAt: null,
  escalatedToMe: false,
  id,
  mine: true,
});

const emptyView: RailView = {
  counts: { everyone: 0, mine: 0 },
  doneToday: 0,
  needsYou: [],
  working: [],
};

const stateWith = (overrides: Partial<NeedsYouState>): NeedsYouState => ({
  actionable: [],
  count: null,
  error: null,
  fresh: new Set(),
  openId: null,
  scope: "mine",
  setScope: noop,
  showToggle: false,
  view: null,
  ...overrides,
});

const render = (state: NeedsYouState) =>
  renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <NeedsYouList onNavigate={noop} pinned={[]} state={state} />
    </RouterContextProvider>
  );

test("the list says Loading and shows no count before the first answer", () => {
  const html = render(stateWith({}));
  expect(html).toContain("Loading");
  expect(html).toContain("Needs you<span></span>");
});

test("a loaded empty list says nothing needs you and counts done today", () => {
  const html = render(stateWith({ count: 0, view: emptyView }));
  expect(html).toContain("Nothing needs you.");
  expect(html).toContain("0 done today");
  expect(html).toContain("Needs you<span>0</span>");
  expect(html).not.toContain("Loading");
});

test("each row links to its item and the heading shows the count", () => {
  const actionable = [
    item("item-a", "Approve the reply"),
    item("item-b", "Review the skill"),
  ];
  const html = render(
    stateWith({
      actionable,
      count: 2,
      view: { ...emptyView, needsYou: actionable },
    })
  );
  expect(html).toContain("Approve the reply");
  expect(html).toContain('href="/desk?item=item-a"');
  expect(html).toContain("Review the skill");
  expect(html).toContain('href="/desk?item=item-b"');
  expect(html).toContain("Needs you<span>2</span>");
});

test("the drawer renders nothing while closed", () => {
  const html = renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <NeedsYouDrawer
        onOpenChange={noop}
        open={false}
        pinned={[]}
        state={stateWith({})}
      />
    </RouterContextProvider>
  );
  expect(html).toBe("");
});
