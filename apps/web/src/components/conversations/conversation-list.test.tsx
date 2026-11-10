import { expect, test } from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationList } from "./conversation-list";
import {
  type ConversationListItem,
  fromRow,
  threadHref,
} from "./conversation-logic";

const noop = () => undefined;
const ACTIVE_ROW = /aria-current="true"[^>]*data-conversation-id="chat-2"/;

const render = (element: ReactElement) => {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/desk"] }),
    routeTree: createRootRoute(),
  });
  return renderToStaticMarkup(
    <RouterContextProvider router={router}>{element}</RouterContextProvider>
  );
};

const assistantItems: ConversationListItem[] = [
  {
    activityAt: "2026-11-09T01:00:00.000Z",
    id: "chat-1",
    kind: "assistant",
    title: "Set up a helper",
  },
  {
    activityAt: "2026-11-08T01:00:00.000Z",
    id: "chat-2",
    kind: "assistant",
    title: "Check on work",
  },
];

test("in the assistant panel: a button per conversation with its time, the active one marked, and a new button", () => {
  const html = render(
    <ConversationList
      activeId="chat-2"
      emptyText="Nothing yet."
      heading="Conversations"
      items={assistantItems}
      label="Conversations"
      onNew={noop}
      onSelect={noop}
    />
  );
  expect(html).toContain('aria-label="Conversations"');
  expect(html).toContain('aria-label="New conversation"');
  expect(html).toContain('data-conversation-id="chat-1"');
  expect(html).toContain("Set up a helper");
  expect(html).toContain('dateTime="2026-11-09T01:00:00.000Z"');
  expect(html).toContain("ago");
  expect(html.match(/aria-current="true"/g)).toHaveLength(1);
  expect(html).toMatch(ACTIVE_ROW);
  expect(html).not.toContain("Show more");
  expect(html).not.toContain(">Assistant<");
});

test("with no conversations it shows the empty text", () => {
  const html = render(
    <ConversationList
      emptyText="Your conversations will appear here."
      items={[]}
      label="Conversations"
    />
  );
  expect(html).toContain("Your conversations will appear here.");
});

test("on the history page: threads link to their page, assistant rows are buttons, each marked with its kind", () => {
  const items: ConversationListItem[] = [
    {
      activityAt: "2026-11-09T02:00:00.000Z",
      detail: "Pelican, UI, Done",
      href: threadHref("s 1"),
      id: "s 1",
      kind: "thread",
      title: "Chase the invoice",
    },
    ...assistantItems.slice(0, 1),
  ];
  const html = render(
    <ConversationList
      emptyText="No conversations."
      items={items}
      label="Conversations"
      onLoadMore={noop}
      onSelect={noop}
      showKind
    />
  );
  expect(html).toContain('href="/threads/s%201"');
  expect(html).toContain("Pelican, UI, Done");
  expect(html).toContain('data-conversation-id="chat-1"');
  expect(html).not.toContain('data-conversation-id="s 1"');
  expect(html).toContain(">Thread<");
  expect(html).toContain(">Assistant<");
  expect(html).toContain("Show more");
});

test("fromRow marks a thread row with its agent, origin and state, and an assistant row with neither", () => {
  const names = new Map([["a1", "Pelican"]]);
  const thread = fromRow(
    {
      activityAt: "2026-11-09T02:00:00.000Z",
      cursor: "c",
      id: "s1",
      kind: "thread",
      thread: {
        agentId: "a1",
        archivedAt: null,
        createdAt: "2026-11-09T01:00:00.000Z",
        cursor: "c",
        externalKey: null,
        id: "s1",
        lastRunAt: "2026-11-09T02:00:00.000Z",
        latestRunId: "r1",
        origin: "slack",
        parentSessionId: null,
        pinnedAt: null,
        private: true,
        status: "running",
        title: "",
      },
      title: "",
    },
    names
  );
  expect(thread).toMatchObject({
    detail: "Pelican, Slack DM, Running",
    href: "/threads/s1",
    kind: "thread",
    title: "Pelican, 2026-11-09 01:00 UTC",
  });
  const chat = fromRow(
    {
      activityAt: "2026-11-09T02:00:00.000Z",
      cursor: "c",
      id: "chat-1",
      kind: "assistant",
      title: "Set up a helper",
    },
    names
  );
  expect(chat).toEqual({
    activityAt: "2026-11-09T02:00:00.000Z",
    id: "chat-1",
    kind: "assistant",
    title: "Set up a helper",
  });
});
