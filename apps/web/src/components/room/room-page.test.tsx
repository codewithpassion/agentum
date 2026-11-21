import { expect, test } from "bun:test";
import type { Team } from "@repo/db/shared";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import type { InboxThread } from "#/integrations/trpc/types";
import { RoomPage } from "./room-page.tsx";

const router = createRouter({
  history: createMemoryHistory({ initialEntries: ["/"] }),
  routeTree: createRootRoute(),
});

const team = (archivedAt: string | null): Team =>
  ({
    archivedAt,
    id: "team_1",
    members: [
      {
        isHome: false,
        memberId: "u_amir",
        memberKind: "user",
        teamId: "team_1",
      },
    ],
    name: "Finance",
    slug: "finance",
  }) as Team;

const openTopic = (): void => undefined;

const threads = [
  {
    id: "t1",
    lastPostAt: "2026-11-19T10:00:00.000Z",
    teamId: "team_1",
    title: "Q3 plans",
  } as InboxThread,
];

const render = (archivedAt: string | null) =>
  renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <RoomPage
        agents={[]}
        handles={new Map()}
        onOpenTopic={openTopic}
        people={[]}
        team={team(archivedAt)}
        threads={threads}
        topicId={undefined}
        userId="u_amir"
      />
    </RouterContextProvider>
  );

test("a live team's room offers New topic", () => {
  const html = render(null);
  expect(html).toContain("New topic");
  expect(html).not.toContain("archived");
});

test("an archived team's room lists its topics, says it is archived and has no New topic", () => {
  const html = render("2026-11-01T00:00:00.000Z");
  expect(html).toContain("Q3 plans");
  expect(html).toContain("This team is archived");
  expect(html).not.toContain("New topic");
  expect(html).toContain("Pick a topic to read.");
});
