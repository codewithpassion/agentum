import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "#/components/ui/tooltip";
import type { RoomData, RoomTabProps } from "./room-data.ts";

/** An active cloud agent with no connections, tasks or conversations. */
export const fixtureRoom = (): RoomData => ({
  agent: {
    backupUserId: null,
    computerMachineId: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    createdBy: "user_1",
    emailLocal: null,
    handsTo: [],
    id: "agent_1",
    instructions: "Sort the inbox every morning.",
    machineId: null,
    model: "sonnet",
    name: "Sorter",
    ownerUserId: "user_1",
    runtime: "cloud",
    runtimeConfig: {},
    slug: "sorter",
    soul: "",
    status: "active",
    subagents: false,
    workspaceId: "ws_1",
  },
  askBefore: [],
  askLevel: "outside",
  connections: [],
  machines: [],
  mailbox: null,
  members: [{ name: "Dev User", userId: "user_1" }] as RoomData["members"],
  profile: {
    channels: { email: "reserved", slack: null },
    does: "Sort the inbox every morning.",
    handsTo: [],
    header: {
      emailLocal: null,
      id: "agent_1",
      machine: null,
      model: "sonnet",
      name: "Sorter",
      runtime: "cloud",
      slug: "sorter",
      status: "active",
      waitingRun: null,
    },
    library: {
      folders: [{ access: "write", home: true, path: "agents/sorter" }],
    },
    receivesFrom: [],
    recentTasks: [],
    skills: [],
    startsOn: { routines: [], slackMention: null, triggers: [] },
    tools: { connectors: [], secrets: [] },
    voice: "",
  },
  published: null,
  rules: [],
  tasks: [],
  threads: [],
});

const noop = (): void => undefined;

export const fixtureTabProps = (): RoomTabProps => ({
  nowMs: null,
  onOpenTab: noop,
  room: fixtureRoom(),
});

/** Renders to static markup inside a router and a tooltip provider, as the room does. */
export const renderInRoom = (element: ReactElement): string => {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute(),
  });
  return renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <TooltipProvider>{element}</TooltipProvider>
    </RouterContextProvider>
  );
};
