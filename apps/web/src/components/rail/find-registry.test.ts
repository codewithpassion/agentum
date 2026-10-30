import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { agentFindEntries, findEntries, pathOf } from "./find-registry.ts";

const EXCLUDED: Readonly<Record<string, string>> = {
  "/agents/$agentId": "needs an agent id, reached from the agent list",
  "/connectors": "redirects to /settings/connectors",
  "/machines": "redirects to /settings/machines",
  "/qa/$questionId": "needs a question id, reached from the Q&A list",
  "/settings": "layout wrapper, Settings pages are listed one by one",
  "/settings/managed-agents": "redirects to model providers",
  "/skills/$skillId": "needs a skill id, reached from the skills list",
  "/tasks/$runId": "needs a run id, reached from the task lists",
};

const routeFiles = readdirSync(
  join(import.meta.dir, "../../routes/_app")
).filter((file) => file.endsWith(".tsx"));

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

test("pathOf drops the query string", () => {
  expect(pathOf("/desk?view=board")).toBe("/desk");
  expect(pathOf("/sessions")).toBe("/sessions");
});
