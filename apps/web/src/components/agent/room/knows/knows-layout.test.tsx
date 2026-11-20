import { expect, mock, test } from "bun:test";
import type {
  DreamRun,
  MemoryChange,
  MemoryNote,
  MemoryRules,
} from "@repo/db/shared";
import { Window } from "happy-dom";
import { fixtureRoom, renderInRoom } from "../test-fixtures.tsx";
import type { DreamApi } from "./dream/use-dream.ts";
import type { MemoryApi, MemoryData } from "./use-memory.ts";

// The Skills panel reads Clerk's auth state, which needs a provider.
mock.module("@clerk/tanstack-react-start", () => ({
  useAuth: () => ({ orgRole: "org:admin", userId: "user_1" }),
}));

const { KnowsLayout } = await import("./knows-layout.tsx");

const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const noop = (): void => undefined;

const note = (over: Partial<MemoryNote>): MemoryNote => ({
  date: "2026-11-11",
  id: "n1",
  kind: "people",
  source: null,
  text: "Mia wants drafts as Google Docs",
  userScope: null,
  writtenBy: "person",
  ...over,
});

const change = (over: Partial<MemoryChange>): MemoryChange => ({
  action: "add",
  agentId: "agent_1",
  createdAt: "2026-11-19T10:00:00.000Z",
  decidedAt: null,
  decidedBy: null,
  dreamRunId: null,
  groupId: null,
  id: "c1",
  kind: "people",
  libraryVersionId: null,
  noteId: "n9",
  source: null,
  status: "applied",
  teamId: null,
  text: "Tom reads reports on his phone",
  userScope: null,
  writtenBy: "agent",
  ...over,
});

const rules = (over: Partial<MemoryRules["agent"]> = {}): MemoryRules => ({
  agent: {
    dreamSchedule: "nightly",
    learnLevel: "tell_after",
    never: ["Deal prices"],
    remember: ["Client preferences"],
    shareWithTeam: true,
    ...over,
  },
  workspaceNever: ["Passwords and keys", "Card and bank numbers"],
});

const api = (over: Partial<MemoryData> = {}): MemoryApi => ({
  add: noop,
  adding: false,
  busyId: null,
  data: {
    changes: [change({})],
    held: [],
    notes: [
      note({}),
      note({ id: "n2", kind: "corrections", text: "No Fridays" }),
    ],
    nowMs: NOW,
    rules: rules(),
    ...over,
  },
  decide: noop,
  edit: noop,
  error: undefined,
  forget: noop,
  reload: () => Promise.resolve(),
  saving: false,
  setRules: noop,
  undo: noop,
});

const dreamApi = (over: Partial<DreamApi> = {}): DreamApi => ({
  decide: noop,
  error: undefined,
  pending: null,
  runNow: noop,
  runs: [],
  undo: noop,
  ...over,
});

const render = (
  memory: MemoryApi,
  canChange: boolean,
  archived = false,
  dream: DreamApi = dreamApi()
) => {
  const room = fixtureRoom();
  if (archived) {
    room.agent.status = "archived";
  }
  const { document } = new Window();
  document.body.innerHTML = renderInRoom(
    <KnowsLayout
      canChange={canChange}
      dream={dream}
      memory={memory}
      room={room}
    />
  );
  return document;
};

const texts = (document: ReturnType<typeof render>, selector: string) =>
  [...document.querySelectorAll(selector)].map((element) =>
    element.textContent.trim()
  );

test("notes are grouped by kind under the agent's name, with the dream card above them", () => {
  const document = render(api(), true);
  expect(texts(document, "h3").slice(0, 2)).toEqual([
    "About people",
    "Corrections",
  ]);
  expect(document.body.textContent).toContain("What Sorter remembers");
  const slot = document.querySelector('[data-slot="dream-card"]');
  expect(slot?.querySelector('[data-testid="dream-card"]')).not.toBeNull();
});

test("the dream card shows the latest dream and Dream now for the owner", () => {
  const run: DreamRun = {
    agentId: "agent_1",
    baseVersion: [],
    counts: { added: 3, dropped: 1, merged: 2, questions: 0 },
    diary: "Sorter reviewed 14 conversations.",
    error: null,
    finishedAt: "2026-11-20T02:05:00.000Z",
    heldChanges: 0,
    id: "dream_1",
    resultVersion: "version_1",
    since: null,
    startedAt: "2026-11-20T02:00:00.000Z",
    status: "done",
    teamId: null,
    usage: null,
  };
  const document = render(api(), true, false, dreamApi({ runs: [run] }));
  const card = document.querySelector('[data-testid="dream-card"]');
  expect(card?.getAttribute("data-state")).toBe("done");
  expect(card?.textContent).toContain("Sorter reviewed 14 conversations.");
  expect(card?.textContent).toContain("Added 3 notes, merged 2, dropped 1.");
  expect(card?.textContent).toContain("Dream now");
});

test("a member sees the diary but not Dream now or the schedule choices", () => {
  const document = render(api(), false);
  const card = document.querySelector('[data-testid="dream-card"]');
  expect(card).not.toBeNull();
  expect(card?.textContent).not.toContain("Dream now");
  expect(card?.querySelector('[role="radio"]')).toBeNull();
});

test("workspace never rules are locked rows and the agent's own can be removed", () => {
  const document = render(api(), true);
  const locked = document.querySelectorAll('[data-testid="locked-rule"]');
  expect(locked.length).toBe(2);
  for (const row of locked) {
    expect(row.textContent).toContain("workspace rule");
    expect(row.querySelector("button")).toBeNull();
  }
  expect(document.body.textContent).toContain("Deal prices");
});

test("a held note shows Approve and Reject beside the group it belongs to", () => {
  const held = change({ id: "h1", status: "held", text: "Mia likes Tuesday" });
  const document = render(api({ held: [held] }), true);
  const row = document.querySelector('[data-testid="held-row"]');
  expect(row?.textContent).toContain("Mia likes Tuesday");
  expect(texts(document, '[data-testid="held-row"] button')).toEqual([
    "Approve",
    "Reject",
  ]);
});

test("a person who cannot change rules sees them disabled with the reason", () => {
  const document = render(api(), false);
  expect(document.body.textContent).toContain(
    "Only the owner or an admin can change these."
  );
  const rulesSection = [...document.querySelectorAll("section")].find(
    (section) => section.textContent.includes("Remember rules")
  );
  const controls = rulesSection?.querySelectorAll(
    "button, input, [role=radio], [role=switch]"
  );
  expect(controls?.length).toBeGreaterThan(0);
  for (const control of controls ?? []) {
    expect(control.hasAttribute("disabled")).toBe(true);
  }
});

test("the owner or an admin sees the rules enabled", () => {
  const document = render(api(), true);
  expect(document.body.textContent).not.toContain(
    "Only the owner or an admin can change these."
  );
  const add = [...document.querySelectorAll("button")].find(
    (button) => button.textContent.trim() === "Add"
  );
  expect(add?.hasAttribute("disabled")).toBe(false);
});

test("Learned this week lists applied changes with Undo and is absent when there are none", () => {
  const withOne = render(api(), true);
  expect(texts(withOne, "h2")).toContain("Learned this week");
  expect(texts(withOne, '[data-testid="learned-row"]')[0]).toContain(
    "Remembered: Tom reads reports on his phone"
  );
  const none = render(api({ changes: [] }), true);
  expect(texts(none, "h2")).not.toContain("Learned this week");
});

test("the Quietly level keeps the agent's changes out of Learned this week", () => {
  const document = render(api({ rules: rules({ learnLevel: "quiet" }) }), true);
  expect(texts(document, "h2")).not.toContain("Learned this week");
});

test("an archived agent's memory controls are disabled and its rules cannot change", () => {
  const document = render(api(), true, true);
  expect(document.body.textContent).toContain(
    "Only the owner or an admin can change these."
  );
  for (const button of document.querySelectorAll(
    '[data-testid="note-row"] button'
  )) {
    expect(button.hasAttribute("disabled")).toBe(true);
  }
});

const OWNER_ONLY = "Only the agent's owners and admins can change its notes.";
const CONTROLS = ["Edit", "Forget", "Approve", "Reject", "Undo"];

const noteControls = (document: ReturnType<typeof render>): string[] =>
  texts(
    document,
    '[data-testid="note-row"] button, [data-testid="held-row"] button, [data-testid="learned-row"] button'
  ).filter((label) => CONTROLS.includes(label));

test("a member sees no way to change the agent's shared notes, and the reason", () => {
  const document = render(
    api({ held: [change({ id: "h1", status: "held", text: "Held note" })] }),
    false
  );
  expect(noteControls(document)).toEqual([]);
  expect(document.body.textContent).toContain(OWNER_ONLY);
});

test("a member can still change their own private note and change", () => {
  const document = render(
    api({
      changes: [change({ userScope: "user_me" })],
      held: [
        change({
          id: "h1",
          status: "held",
          text: "Held private",
          userScope: "user_me",
        }),
      ],
      notes: [note({ userScope: "user_me" })],
    }),
    false
  );
  expect(noteControls(document)).toEqual([
    "Approve",
    "Reject",
    "Edit",
    "Forget",
    "Undo",
  ]);
});

test("the owner or an admin sees every control and no reason", () => {
  const document = render(
    api({ held: [change({ id: "h1", status: "held", text: "Held note" })] }),
    true
  );
  expect(noteControls(document)).toEqual([
    "Approve",
    "Reject",
    "Edit",
    "Forget",
    "Edit",
    "Forget",
    "Undo",
  ]);
  expect(document.body.textContent).not.toContain(OWNER_ONLY);
});

test("an error from an action shows as an alert", () => {
  const memory = { ...api(), error: "This note looks like it holds a secret" };
  const document = render(memory, true);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "holds a secret"
  );
});
