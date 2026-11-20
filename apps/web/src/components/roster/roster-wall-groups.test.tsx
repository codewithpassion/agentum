/** biome-ignore-all lint/suspicious/useAwait: Async React act flushes queued effects and promises. */
/** biome-ignore-all lint/performance/noJsxPropsBind: The harness drives real state transitions. */
import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import type { AgentCard, Team } from "@repo/db/shared";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  Dialog as RealDialog,
  DialogContent as RealDialogContent,
  DialogDescription as RealDialogDescription,
  DialogHeader as RealDialogHeader,
  DialogTitle as RealDialogTitle,
} from "#/components/ui/dialog";
import { collapsedKey } from "./roster-logic.ts";

// The group heading collapses its cards, the choice is kept per person in local
// storage, and "Add to team" opens the member picker.

const dom = new Window({ url: "http://localhost/" });
const previous = new Map<string, PropertyDescriptor | undefined>();
const KEYS = [
  "window",
  "document",
  "navigator",
  "Event",
  "HTMLElement",
  "Node",
  "MutationObserver",
  "getComputedStyle",
  "ResizeObserver",
  "CustomEvent",
  "KeyboardEvent",
  "MouseEvent",
  "HTMLButtonElement",
  "NodeFilter",
  "FocusEvent",
  "HTMLInputElement",
  "IS_REACT_ACT_ENVIRONMENT",
];

// Live bindings follow a mock, so the real components are copied before one exists.
const realDialog = {
  Dialog: RealDialog,
  DialogContent: RealDialogContent,
  DialogDescription: RealDialogDescription,
  DialogHeader: RealDialogHeader,
  DialogTitle: RealDialogTitle,
};

let RosterWall: typeof import("./roster-wall.tsx").RosterWall;

// The shadcn dialog stands in for a plain element: Radix decides whether it runs
// in a browser when it first loads, and other test files load it before this one.
beforeAll(async () => {
  mock.module("#/components/ui/dialog", () => ({
    Dialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
      open ? <div role="dialog">{children}</div> : null,
    DialogContent: ({ children }: { children: ReactNode }) => <>{children}</>,
    DialogDescription: ({ children }: { children: ReactNode }) => (
      <p>{children}</p>
    ),
    DialogHeader: ({ children }: { children: ReactNode }) => <>{children}</>,
    DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  }));
  for (const key of KEYS) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(dom, key),
    });
  }
  ({ RosterWall } = await import("./roster-wall.tsx"));
});
afterAll(() => {
  mock.module("#/components/ui/dialog", () => realDialog);

  for (const [key, descriptor] of previous) {
    if (descriptor) {
      Object.defineProperty(globalThis, key, descriptor);
    } else {
      Reflect.deleteProperty(globalThis, key);
    }
  }
});
beforeEach(() => {
  dom.localStorage.clear();
  document.body.innerHTML = "";
});

const router = createRouter({
  history: createMemoryHistory({ initialEntries: ["/"] }),
  routeTree: createRootRoute(),
});

const card = (
  name: string,
  teamId: string | null,
  id = name.toLowerCase()
): AgentCard => ({
  avatar: { color: "slate", glyph: name.charAt(0) },
  costThisWeekCents: 0,
  doneAt: null,
  id,
  isLead: false,
  jobLine: "",
  learnedCount: 0,
  name,
  needsYouCount: 0,
  ownerName: "Dom",
  slug: id,
  state: "idle",
  statusLine: "Idle",
  teamId,
  weeklyCapCents: null,
});

const team = (id: string, name: string, agentIds: string[]): Team => ({
  archivedAt: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  folderPath: null,
  id,
  leadAgentId: null,
  leadListens: true,
  members: agentIds.map((memberId) => ({
    isHome: true,
    memberId,
    memberKind: "agent" as const,
    teamId: id,
  })),
  name,
  ownerUserId: null,
  rules: "",
  slug: name.toLowerCase(),
});

const CARDS = [card("Ruby", "t_ops"), card("Tess", "t_dev"), card("Zed", null)];
const TEAMS = [team("t_ops", "Ops", ["ruby"]), team("t_dev", "Dev", ["tess"])];

const mount = async (
  userId: string,
  onAddMember: (teamId: string, agentId: string) => Promise<void> = () =>
    Promise.resolve()
) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () =>
    root.render(
      <RouterContextProvider router={router}>
        <RosterWall
          cards={CARDS}
          chips={[]}
          onAddMember={onAddMember}
          teams={TEAMS}
          userId={userId}
        />
      </RouterContextProvider>
    )
  );
  return { container, root };
};

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

const toggleFor = (container: Element, name: string): HTMLButtonElement => {
  for (const button of container.querySelectorAll("button[aria-expanded]")) {
    if (button.textContent === name) {
      return button as HTMLButtonElement;
    }
  }
  throw new Error(`No toggle named ${name}`);
};

test("collapsing a group hides its cards, keeps the others and remembers the choice", async () => {
  const { container } = await mount("user_1");
  expect(container.textContent).toContain("Ruby");
  expect(container.textContent).toContain("Tess");

  await act(async () => toggleFor(container, "Ops").click());
  expect(container.textContent).not.toContain("Ruby");
  expect(container.textContent).toContain("Tess");
  expect(toggleFor(container, "Ops").getAttribute("aria-expanded")).toBe(
    "false"
  );
  expect(dom.localStorage.getItem(collapsedKey("user_1"))).toBe('["t_ops"]');

  await act(async () => toggleFor(container, "Ops").click());
  expect(container.textContent).toContain("Ruby");
  expect(dom.localStorage.getItem(collapsedKey("user_1"))).toBe("[]");
});

test("a stored choice applies on the next visit, for that person only", async () => {
  dom.localStorage.setItem(collapsedKey("user_1"), '["t_dev","no-team"]');

  const mine = await mount("user_1");
  expect(mine.container.textContent).toContain("Ruby");
  expect(mine.container.textContent).not.toContain("Tess");
  expect(mine.container.textContent).not.toContain("Zed");
  await act(async () => mine.root.unmount());

  const other = await mount("user_2");
  expect(other.container.textContent).toContain("Tess");
  expect(other.container.textContent).toContain("Zed");
});

const pickAgent = async (dialog: Element | null, agentId: string) => {
  const select = dialog?.querySelector("select") as HTMLSelectElement;
  select.value = agentId;
  await act(async () => {
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const add = [...(dialog?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent === "Add"
  );
  await act(async () => add?.click());
  await settle();
};

test("Add to team opens the one member picker, lists agents outside the team and adds the pick", async () => {
  const added: [string, string][] = [];
  const { container } = await mount("user_1", (teamId, agentId) => {
    added.push([teamId, agentId]);
    return Promise.resolve();
  });

  const addButtons = container.querySelectorAll(
    'button[aria-label="Add to team Ops"]'
  );
  expect(addButtons).toHaveLength(1);
  await act(async () => (addButtons[0] as HTMLButtonElement).click());
  await settle();

  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog?.textContent).toContain("Add to Ops");
  const options = [...(dialog?.querySelectorAll("option") ?? [])].map(
    (option) => option.textContent
  );
  expect(options).toEqual(["Choose an agent", "Tess", "Zed"]);

  await pickAgent(dialog, "zed");
  expect(added).toEqual([["t_ops", "zed"]]);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test("a refused add keeps the picker open and shows the message", async () => {
  const { container } = await mount("user_1", () =>
    Promise.reject(new Error("Only the team owner can add agents."))
  );
  await act(async () =>
    (
      container.querySelector(
        'button[aria-label="Add to team Ops"]'
      ) as HTMLButtonElement
    ).click()
  );
  await settle();

  const dialog = document.querySelector('[role="dialog"]');
  await pickAgent(dialog, "zed");
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    "Only the team owner can add agents."
  );
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
});
