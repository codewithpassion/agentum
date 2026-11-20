import { expect, test } from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { RoomLink } from "./room-link.tsx";

const router = createRouter({
  history: createMemoryHistory({ initialEntries: ["/"] }),
  routeTree: createRootRoute(),
});

const render = (teamId: string, teamName: string) =>
  renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <RoomLink teamId={teamId} teamName={teamName} />
    </RouterContextProvider>
  );

const ROOM_HREF = /href="\/teams\/team%20a%2Fb\/room"/;

test("the link points at the team's room with the id encoded", () => {
  const html = render("team a/b", "Sales");
  expect(html).toMatch(ROOM_HREF);
});

test("the link shows Open room and labels it with the team name", () => {
  const html = render("team-1", "Sales");
  expect(html).toContain(">Open room</a>");
  expect(html).toContain('aria-label="Open room for Sales"');
});
