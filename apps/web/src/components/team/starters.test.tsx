/** biome-ignore-all lint/suspicious/useAwait: React act flushes queued updates. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { teamFromStarterInputSchema } from "@repo/services/agent-builder/team-starters";
import { type HTMLButtonElement, Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { NewTeamBody } from "./new-team-dialog.tsx";
import {
  missingRuntime,
  type StarterReview,
  TEAM_STARTERS,
} from "./starter-logic.ts";

const dom = new Window();
const keys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Node",
  "IS_REACT_ACT_ENVIRONMENT",
];
const previous = new Map<string, PropertyDescriptor | undefined>();

beforeAll(() => {
  for (const key of keys) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(dom, key),
    });
  }
});
afterAll(() => {
  for (const key of keys) {
    const old = previous.get(key);
    if (old === undefined) {
      Reflect.deleteProperty(globalThis, key);
    } else {
      Object.defineProperty(globalThis, key, old);
    }
  }
});

const member = (name: string, runsOn: { runtime: "cloud" } | null) => ({
  does: `${name} does work.`,
  handsTo: [],
  library: [],
  name,
  rules: [],
  runsOn,
  sampleInput: [],
  skills: [],
  startsOn: [],
  tools: [],
  voice: "friendly" as const,
});
const reviewOf = (runsOn: { runtime: "cloud" } | null): StarterReview => ({
  draft: {
    members: [
      member("Sales lead", runsOn),
      member("Lead research", runsOn),
      member("Outreach drafts", runsOn),
      member("CRM tidy", runsOn),
    ],
    name: "Sales",
    rules: "Share progress in the team room.",
  },
});

const noop = () => undefined;
const buttons = (root: Element) =>
  [...root.querySelectorAll("button")] as unknown as HTMLButtonElement[];
const byText = (root: Element, text: string) =>
  buttons(root).find((button) => button.textContent?.includes(text));

test("the starter list matches the service", () => {
  expect(TEAM_STARTERS.map((starter) => starter.key).sort()).toEqual(
    [...teamFromStarterInputSchema.options].sort()
  );
});

test("a review without a runtime is flagged", () => {
  expect(missingRuntime(reviewOf(null))).toBe(true);
  expect(missingRuntime(reviewOf({ runtime: "cloud" }))).toBe(false);
});

const loaded: string[] = [];
const created: StarterReview[] = [];
let nextReview = reviewOf({ runtime: "cloud" });
const loadStarter = async (key: string) => {
  loaded.push(key);
  return nextReview;
};
const createStarter = async (review: StarterReview) => {
  created.push(review);
};
const create = async () => undefined;

const mount = async () => {
  const container = dom.document.createElement("div") as unknown as Element;
  dom.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <NewTeamBody
        agents={[]}
        loadStarter={loadStarter}
        onCancel={noop}
        onCreate={create}
        onCreateStarter={createStarter}
        people={[]}
        youId="u1"
      />
    );
  });
  return { container, root };
};

test("the dialog lists both starters, and confirming one creates it from its draft", async () => {
  nextReview = reviewOf({ runtime: "cloud" });
  const { container, root } = await mount();
  expect(container.textContent).toContain("Sales");
  expect(container.textContent).toContain("Back office");
  await act(async () => {
    byText(container, "Back office")?.click();
  });
  expect(loaded).toEqual(["back_office"]);
  expect(container.textContent).toContain("Sales lead");
  expect(container.textContent).toContain("Share progress in the team room.");
  await act(async () => {
    byText(container, "Create team")?.click();
  });
  expect(created).toHaveLength(1);
  expect(created[0]?.draft.members).toHaveLength(4);
  await act(async () => root.unmount());
});

test("with no runtime the review says so and Create is disabled", async () => {
  nextReview = reviewOf(null);
  const { container, root } = await mount();
  await act(async () => {
    byText(container, "Sales")?.click();
  });
  expect(container.textContent).toContain("nowhere to run");
  expect(byText(container, "Create team")?.disabled).toBe(true);
  await act(async () => root.unmount());
});
