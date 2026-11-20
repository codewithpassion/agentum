import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { ENROLL_BUTTON_LABEL } from "#/components/machines/machine-logic.ts";
import {
  agentFindEntries,
  findEntries,
  pathOf,
  teamFindEntries,
  teamRoomFindEntries,
} from "./find-registry.ts";

const EXCLUDED: Readonly<Record<string, string>> = {
  "/agents/$agentId": "needs an agent id, reached from the agent list",
  "/inbox": "redirects to the Everyone team's room",
  "/qa/$questionId": "needs a question id, reached from the Q&A list",
  "/routines": "redirects to Jobs",
  "/settings": "layout wrapper, Settings pages are listed one by one",
  "/settings/agent-connections/$connectionId":
    "needs a connection id, reached from the connections list",
  "/skills/$skillId": "needs a skill id, reached from the skills list",
  "/tasks/$runId": "redirects to its thread",
  "/teams/$teamId": "needs a team id, reached from the Teams list and Find",
  "/teams/$teamId_/room": "needs a team id, reached from the team page",
  "/threads/$sessionId": "needs a session id, reached from the thread lists",
  "/triggers": "redirects to Jobs",
};

const ROUTES_DIR = join(import.meta.dir, "../../routes/_app");

const routeFiles = readdirSync(ROUTES_DIR).filter((file) =>
  file.endsWith(".tsx")
);

const TSX_EXTENSION = /\.tsx$/;

function routePathOf(file: string): string {
  const segments = file.replace(TSX_EXTENSION, "").split(".");
  if (segments.at(-1) === "index") {
    segments.pop();
  }
  return `/${segments.join("/")}`;
}

const routePaths = routeFiles.map(routePathOf);

function isDynamic(path: string): boolean {
  return path.split("/").some((segment) => segment.startsWith("$"));
}

const registeredPaths = findEntries.map((entry) => pathOf(entry.to));

test("every route file is in the registry or excluded with a reason", () => {
  const registered = new Set(registeredPaths);
  const uncovered = routePaths.filter(
    (path) => !(registered.has(path) || path in EXCLUDED)
  );
  expect(uncovered).toEqual([]);
});

test("every excluded path matches a route file", () => {
  const stale = Object.keys(EXCLUDED).filter(
    (path) => !routePaths.includes(path)
  );
  expect(stale).toEqual([]);
});

test("every registry path is an existing, non-dynamic route", () => {
  const unknown = registeredPaths.filter(
    (path) => !routePaths.includes(path) || isDynamic(path)
  );
  expect(unknown).toEqual([]);
});

test("no two entries share a destination", () => {
  const targets = findEntries.map((entry) => entry.to);
  expect(new Set(targets).size).toBe(targets.length);
});

test("every entry has a label and a group", () => {
  for (const entry of findEntries) {
    expect(entry.label.trim()).not.toBe("");
    expect(entry.group.trim()).not.toBe("");
  }
});

test("Apps is in What agents use and opens the app artifacts list", () => {
  expect(
    findEntries.filter(
      (entry) => entry.label === "Apps" && entry.group === "What agents use"
    )
  ).toEqual([
    expect.objectContaining({
      group: "What agents use",
      hint: "Artifacts",
      to: "/artifacts?kind=app",
    }),
  ]);
});

test("Settings lists sign-ins, connectors as Apps and secrets as passwords and keys", () => {
  const settings = findEntries.filter((entry) => entry.group === "Settings");
  expect(settings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        group: "Settings",
        hint: "Your logins",
        label: "Your sign-ins",
        to: "/settings/sign-ins",
      }),
      expect.objectContaining({
        group: "Settings",
        hint: "Connectors",
        label: "Apps",
        to: "/settings/connectors",
      }),
      expect.objectContaining({
        group: "Settings",
        hint: "Secrets",
        label: "Passwords and keys",
        to: "/settings/secrets",
      }),
    ])
  );
});

test("agentFindEntries links each agent by id", () => {
  expect(
    agentFindEntries([
      { id: "a1", name: "Triage" },
      { id: "a2", name: "Reviewer" },
    ])
  ).toEqual([
    { id: "a1", label: "Triage", to: "/agents/a1" },
    { id: "a2", label: "Reviewer", to: "/agents/a2" },
  ]);
});

test("teamFindEntries links each team by id", () => {
  expect(
    teamFindEntries([
      { id: "t1", name: "Sales" },
      { id: "t2", name: "Back office" },
    ])
  ).toEqual([
    { id: "t1", label: "Sales", to: "/teams/t1" },
    { id: "t2", label: "Back office", to: "/teams/t2" },
  ]);
});

test("teamRoomFindEntries links each team's room", () => {
  expect(
    teamRoomFindEntries([
      { id: "t1", name: "Sales" },
      { id: "t2", name: "Back office" },
    ])
  ).toEqual([
    { id: "t1", label: "Sales room", to: "/teams/t1/room" },
    { id: "t2", label: "Back office room", to: "/teams/t2/room" },
  ]);
});

test("Find no longer lists the Inbox", () => {
  expect(
    findEntries.some(
      (entry) => entry.label === "Inbox" || entry.to.startsWith("/inbox")
    )
  ).toBe(false);
});

test("pathOf drops the query string", () => {
  expect(pathOf("/desk?view=board")).toBe("/desk");
  expect(pathOf("/sessions")).toBe("/sessions");
});

test("Find enrols a machine under the same name as the page button", () => {
  expect(
    findEntries.filter((entry) => entry.to === "/settings/machines")
  ).toEqual([expect.objectContaining({ label: ENROLL_BUTTON_LABEL })]);
});

/** Entries whose label is not the heading of a page of its own, with why. */
const LABEL_EXCEPTIONS: Readonly<Record<string, string>> = {
  "/artifacts?kind=app": "the Apps filter of the Artifacts page",
  "/assistant": "redirects to the Desk with the assistant open, no heading",
  "/settings/machines": "named after the page button, see the test below",
};

function routeFileOf(path: string): string {
  const file = routeFiles.find((candidate) => routePathOf(candidate) === path);
  if (file === undefined) {
    throw new Error(`No route file for ${path}`);
  }
  return join(ROUTES_DIR, file);
}

test("each Find label is the heading its page exports", async () => {
  const checked = findEntries.filter(
    (entry) => !(entry.to in LABEL_EXCEPTIONS)
  );
  const routes: { PAGE_HEADING?: unknown }[] = await Promise.all(
    checked.map((entry) => import(routeFileOf(pathOf(entry.to))))
  );
  const mismatched = checked.flatMap((entry, index) =>
    routes[index]?.PAGE_HEADING === entry.label
      ? []
      : [`${entry.to}: ${entry.label} is not ${routes[index]?.PAGE_HEADING}`]
  );
  expect(mismatched).toEqual([]);
});

test("every label exception is a registry entry", () => {
  const targets = new Set(findEntries.map((entry) => entry.to));
  expect(
    Object.keys(LABEL_EXCEPTIONS).filter((to) => !targets.has(to))
  ).toEqual([]);
});
