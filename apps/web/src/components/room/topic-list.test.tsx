import { expect, test } from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import type { InboxThread } from "#/integrations/trpc/types";
import { TopicList } from "./topic-list.tsx";

const router = createRouter({
  history: createMemoryHistory({ initialEntries: ["/"] }),
  routeTree: createRootRoute(),
});

const thread = (id: string, title: string): InboxThread =>
  ({
    id,
    lastPostAt: "2026-11-19T10:00:00.000Z",
    teamId: "team_1",
    title,
  }) as InboxThread;

const render = (activeId: string | undefined, threads: InboxThread[]) =>
  renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <TopicList activeId={activeId} teamId="team_1" threads={threads} />
    </RouterContextProvider>
  );

test("each topic links to the team room with the topic in the search", () => {
  const html = render(undefined, [thread("t1", "Q3 plans")]);
  expect(html).toContain('href="/teams/team_1/room?topic=t1"');
  expect(html).toContain("Q3 plans");
});

test("the topics sit in a nav labelled Topics", () => {
  expect(render(undefined, [thread("t1", "Q3 plans")])).toContain(
    'aria-label="Topics"'
  );
});

test("only the active topic is marked as current", () => {
  const html = render("t2", [thread("t1", "First"), thread("t2", "Second")]);
  expect(html.match(/aria-current="true"/g)).toHaveLength(1);
  expect(html).toContain('href="/teams/team_1/room?topic=t2"');
});

test("an empty list says there are no topics yet", () => {
  const html = render(undefined, []);
  expect(html).toContain("No topics yet.");
  expect(html).not.toContain("<nav");
});
