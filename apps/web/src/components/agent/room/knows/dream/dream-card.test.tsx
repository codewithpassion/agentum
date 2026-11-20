import { expect, test } from "bun:test";
import type { DreamRun } from "@repo/db/shared";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { Window } from "happy-dom";
import type { ReactElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderInRoom } from "../../test-fixtures.tsx";
import { DreamCard, type DreamCardProps } from "./dream-card.tsx";

const HOUR_MS = 3_600_000;
/** Noon on 20 Nov in the viewer's time zone, so an hour earlier is still today. */
const NOW = new Date(2026, 10, 20, 12, 0).getTime();
const noop = (): void => undefined;

const run = (overrides: Partial<DreamRun> = {}): DreamRun => ({
  agentId: "agent_1",
  baseVersion: [],
  counts: { added: 0, dropped: 0, merged: 0, questions: 0 },
  diary: "",
  error: null,
  finishedAt: null,
  heldChanges: 0,
  id: "run_1",
  openQuestions: 0,
  resultVersion: null,
  since: null,
  startedAt: new Date(NOW - HOUR_MS).toISOString(),
  status: "done",
  teamId: null,
  usage: null,
  ...overrides,
});

const props = (overrides: Partial<DreamCardProps> = {}): DreamCardProps => ({
  agentName: "Sorter",
  canChange: true,
  disabled: false,
  nowMs: NOW,
  onDecide: noop,
  onRunNow: noop,
  onSchedule: noop,
  onUndo: noop,
  pending: null,
  runs: [],
  schedule: "nightly",
  ...overrides,
});

type TestDocument = Window["document"];

const render = (overrides: Partial<DreamCardProps> = {}): TestDocument => {
  const { document } = new Window();
  document.body.innerHTML = renderInRoom(<DreamCard {...props(overrides)} />);
  return document;
};

const card = (document: TestDocument) =>
  document.querySelector('[data-testid="dream-card"]');

const radiosOf = (document: TestDocument) =>
  Array.from(document.querySelectorAll("button")).filter(
    (button) => button.getAttribute("role") === "radio"
  );

const buttonNamed = (document: TestDocument, name: string) =>
  Array.from(document.querySelectorAll("button")).find(
    (button) => (button.textContent ?? "").trim() === name
  );

/** Globals Radix reads from the browser, so the radio group can take a click. */
const DOM_GLOBALS = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "getComputedStyle",
  "ResizeObserver",
  "MutationObserver",
  "CustomEvent",
  "KeyboardEvent",
  "HTMLFormElement",
  "HTMLInputElement",
  "HTMLButtonElement",
  "Event",
  "MouseEvent",
  "Node",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

/** Mounts the card in a browser-like DOM so clicks reach the handlers. */
const mount = async (element: ReactElement) => {
  const dom = new Window({ url: "http://localhost/" });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const key of DOM_GLOBALS) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(dom, key),
    });
  }
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container as unknown as Element);
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute(),
  });
  await act(async () =>
    root.render(
      <RouterContextProvider router={router}>{element}</RouterContextProvider>
    )
  );
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      for (const [key, descriptor] of previous) {
        if (descriptor) {
          Object.defineProperty(globalThis, key, descriptor);
        } else {
          Reflect.deleteProperty(globalThis, key);
        }
      }
    },
  };
};

test("with no dreams yet the card says the agent has not dreamed", () => {
  const document = render();
  expect(card(document)?.getAttribute("data-state")).toBe("none");
  expect(card(document)?.querySelector("h2")?.textContent).toBe("Dreaming");
  expect(card(document)?.textContent).toContain(
    "Sorter has not dreamed yet. A dream reads what happened since the last one, tidies the notes and writes a diary entry here."
  );
});

test("a running dream says it is dreaming and has no diary yet", () => {
  const document = render({
    runs: [run({ status: "running" })],
  });
  expect(card(document)?.getAttribute("data-state")).toBe("running");
  expect(card(document)?.querySelector("h2")?.textContent).toBe(
    "Today's dream"
  );
  expect(card(document)?.textContent).toContain(
    "Dreaming now. The diary appears here when it ends."
  );
});

test("Dream now is disabled while the latest dream is still running", () => {
  const document = render({ runs: [run({ status: "running" })] });
  expect(buttonNamed(document, "Dream now")?.disabled).toBe(true);
});

test("a skipped dream with no diary says nothing changed", () => {
  const document = render({ runs: [run({ status: "skipped" })] });
  expect(card(document)?.getAttribute("data-state")).toBe("skipped");
  expect(card(document)?.textContent).toContain(
    "Nothing new happened since the last dream, so nothing changed."
  );
});

test("a skipped dream with a diary shows the diary", () => {
  const document = render({
    runs: [run({ diary: "A quiet day.", status: "skipped" })],
  });
  expect(card(document)?.textContent).toContain("A quiet day.");
});

test("a failed dream says it changed nothing and shows the error", () => {
  const document = render({
    runs: [run({ error: "Model timed out.", status: "failed" })],
  });
  expect(card(document)?.getAttribute("data-state")).toBe("failed");
  expect(card(document)?.textContent).toContain(
    "The dream failed and changed nothing."
  );
  expect(card(document)?.textContent).toContain("Model timed out.");
});

test("a done dream shows the diary and what it changed, with no question line", () => {
  const document = render({
    runs: [
      run({
        counts: { added: 2, dropped: 0, merged: 1, questions: 0 },
        diary: "Tidied the people notes.",
        resultVersion: "version_1",
        status: "done",
      }),
    ],
  });
  expect(card(document)?.getAttribute("data-state")).toBe("done");
  expect(card(document)?.textContent).toContain("Tidied the people notes.");
  expect(card(document)?.textContent).toContain("Added 2 notes, merged 1.");
  expect(card(document)?.querySelector("a")).toBeNull();
  expect(buttonNamed(document, "See changes")).toBeDefined();
  expect(buttonNamed(document, "Undo this night")).toBeDefined();
});

test("a done dream with a question shows the question and links to Needs you", () => {
  const document = render({
    runs: [
      run({
        counts: { added: 0, dropped: 0, merged: 0, questions: 2 },
        diary: "Two things I was unsure of.",
        openQuestions: 2,
        status: "done",
      }),
    ],
  });
  expect(card(document)?.textContent).toContain(
    "2 questions are waiting for you."
  );
  const link = card(document)?.querySelector("a");
  expect(link?.textContent).toBe("Open Needs you");
  expect(link?.getAttribute("href")).toBe("/desk");
});

test("an undone dream says the night is undone and has no undo button", () => {
  const document = render({
    runs: [run({ diary: "Tidied the people notes.", status: "undone" })],
  });
  expect(card(document)?.getAttribute("data-state")).toBe("undone");
  expect(card(document)?.textContent).toContain(
    "You undid this night. The notes are back as they were."
  );
  expect(card(document)?.textContent).toContain("Tidied the people notes.");
  expect(buttonNamed(document, "See changes")).toBeDefined();
  expect(buttonNamed(document, "Undo this night")).toBeUndefined();
});

test("Dream now and the schedule picker are absent without canChange, and the schedule shows as a line", () => {
  const document = render({ canChange: false, schedule: "weekly" });
  expect(buttonNamed(document, "Dream now")).toBeUndefined();
  expect(card(document)?.querySelector("fieldset")).toBeNull();
  expect(card(document)?.textContent).toContain("Dreams weekly.");
});

test("a member cannot undo a night, and a night that changed nothing has no Undo", () => {
  const changed = run({
    counts: { added: 1, dropped: 0, merged: 0, questions: 0 },
    resultVersion: "version_1",
    status: "done",
  });
  const asMember = render({ canChange: false, runs: [changed] });
  expect(buttonNamed(asMember, "Undo this night")).toBeUndefined();
  expect(buttonNamed(asMember, "See changes")).toBeDefined();
  const nothing = render({ runs: [run({ status: "done" })] });
  expect(buttonNamed(nothing, "Undo this night")).toBeUndefined();
});

test("an archived agent gets no buttons that act", () => {
  const document = render({
    disabled: true,
    runs: [
      run({
        counts: { added: 1, dropped: 0, merged: 0, questions: 0 },
        resultVersion: "version_1",
        status: "done",
      }),
    ],
  });
  expect(buttonNamed(document, "Dream now")?.disabled).toBe(true);
  expect(buttonNamed(document, "Undo this night")).toBeUndefined();
  expect(radiosOf(document).every((radio) => radio.disabled)).toBe(true);
});

test("Dream now shows Dreaming and Undo shows Undoing while those actions are pending", () => {
  const dreaming = render({ pending: "run" });
  expect(buttonNamed(dreaming, "Dreaming…")?.disabled).toBe(true);

  const undoing = render({
    pending: "undo",
    runs: [
      run({
        counts: { added: 1, dropped: 0, merged: 0, questions: 0 },
        resultVersion: "version_1",
        status: "done",
      }),
    ],
  });
  expect(buttonNamed(undoing, "Undoing…")?.disabled).toBe(true);
  expect(buttonNamed(undoing, "Dream now")?.disabled).toBe(true);
});

test("Dream now and the schedule radios are disabled while a schedule change is pending", () => {
  const document = render({ pending: "schedule" });
  expect(buttonNamed(document, "Dream now")?.disabled).toBe(true);
  expect(radiosOf(document)).toHaveLength(3);
  expect(radiosOf(document).every((radio) => radio.disabled)).toBe(true);
});

test("clicking Dream now calls onRunNow", async () => {
  let calls = 0;
  const { container, unmount } = await mount(
    <DreamCard
      {...props({
        onRunNow: () => {
          calls += 1;
        },
      })}
    />
  );
  try {
    const button = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "Dream now"
    );
    await act(async () => button?.click());
    expect(calls).toBe(1);
  } finally {
    await unmount();
  }
});

test("clicking Undo this night calls onUndo with the run id", async () => {
  const undone: string[] = [];
  const { container, unmount } = await mount(
    <DreamCard
      {...props({
        onUndo: (id) => undone.push(id),
        runs: [
          run({
            counts: { added: 1, dropped: 0, merged: 0, questions: 0 },
            id: "run_7",
            resultVersion: "version_1",
            status: "done",
          }),
        ],
      })}
    />
  );
  try {
    const button = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "Undo this night"
    );
    await act(async () => button?.click());
    expect(undone).toEqual(["run_7"]);
  } finally {
    await unmount();
  }
});

test("clicking a schedule option calls onSchedule with that schedule", async () => {
  const chosen: string[] = [];
  const { container, unmount } = await mount(
    <DreamCard {...props({ onSchedule: (next) => chosen.push(next) })} />
  );
  try {
    const weekly = Array.from(container.querySelectorAll("label")).find(
      (label) => label.textContent?.startsWith("Weekly")
    );
    const radio = weekly?.querySelector("button");
    await act(async () => radio?.click());
    expect(chosen).toEqual(["weekly"]);
  } finally {
    await unmount();
  }
});

const heldRun = (overrides: Partial<DreamRun> = {}): DreamRun =>
  run({
    counts: { added: 1, dropped: 1, merged: 0, questions: 0 },
    diary: "Two changes to hold.",
    heldChanges: 2,
    id: "run_held",
    status: "done",
    ...overrides,
  });

test("a held dream shows its diary and the held batch with Approve and Reject", () => {
  const document = render({ runs: [heldRun()] });
  expect(card(document)?.getAttribute("data-state")).toBe("held");
  expect(card(document)?.textContent).toContain("Two changes to hold.");
  expect(document.querySelector('[data-testid="held-batch"]')).not.toBeNull();
  expect(buttonNamed(document, "Approve")?.disabled).toBe(false);
  expect(buttonNamed(document, "Reject")?.disabled).toBe(false);
});

test("a held dream for a member shows the batch with no Approve or Reject and no Dream now", () => {
  const document = render({ canChange: false, runs: [heldRun()] });
  expect(document.querySelector('[data-testid="held-batch"]')).not.toBeNull();
  expect(buttonNamed(document, "Approve")).toBeUndefined();
  expect(buttonNamed(document, "Reject")).toBeUndefined();
  expect(buttonNamed(document, "Dream now")).toBeUndefined();
});

test("a held dream has no Undo button and no counts line", () => {
  const document = render({ runs: [heldRun()] });
  expect(buttonNamed(document, "Undo this night")).toBeUndefined();
  expect(card(document)?.textContent).not.toContain("Added 1 note");
});

test("the held batch's buttons are disabled for an archived agent", () => {
  const document = render({ disabled: true, runs: [heldRun()] });
  expect(buttonNamed(document, "Approve")?.disabled).toBe(true);
  expect(buttonNamed(document, "Reject")?.disabled).toBe(true);
});

test("clicking Approve and Reject on a held dream calls onDecide with the run id and the decision", async () => {
  const decided: string[][] = [];
  const { container, unmount } = await mount(
    <DreamCard
      {...props({
        onDecide: (id, decision) => decided.push([id, decision]),
        runs: [heldRun()],
      })}
    />
  );
  try {
    const find = (name: string) =>
      Array.from(container.querySelectorAll("button")).find(
        (candidate) => candidate.textContent === name
      );
    await act(async () => find("Approve")?.click());
    await act(async () => find("Reject")?.click());
    expect(decided).toEqual([
      ["run_held", "approve"],
      ["run_held", "reject"],
    ]);
  } finally {
    await unmount();
  }
});

test("a rejected dream shows its diary and no applied counts, Undo or buttons", () => {
  const document = render({
    runs: [
      run({
        counts: { added: 1, dropped: 0, merged: 0, questions: 0 },
        diary: "You rejected these changes. Nothing was changed.",
      }),
    ],
  });
  const text = card(document)?.textContent ?? "";
  expect(card(document)?.getAttribute("data-state")).toBe("rejected");
  expect(text).toContain("You rejected these changes.");
  expect(text).not.toContain("Added 1 note");
  expect(buttonNamed(document, "Undo this night")).toBeUndefined();
});

const HELD_DIARY = [
  "These changes wait for your approval. Wants to add 3 notes.",
  "Would add: Ships on Fridays.",
].join("\n");
const HELD_COUNTS = { added: 3, dropped: 0, merged: 0, questions: 0 };

test("a held dream still says its changes wait for approval, in the future tense", () => {
  const document = render({
    runs: [run({ counts: HELD_COUNTS, diary: HELD_DIARY, heldChanges: 3 })],
  });
  const text = card(document)?.textContent ?? "";
  expect(card(document)?.getAttribute("data-state")).toBe("held");
  expect(text).toContain(
    "These changes wait for your approval. Wants to add 3 notes."
  );
  expect(text).toContain("Would add: Ships on Fridays.");
  expect(buttonNamed(document, "Approve")).toBeDefined();
});

test("an approved dream drops the held sentence and words its changes in the past tense", () => {
  const document = render({
    runs: [
      run({
        counts: HELD_COUNTS,
        diary: `${HELD_DIARY}\nYou approved these changes.`,
        resultVersion: "version_1",
      }),
    ],
  });
  const text = card(document)?.textContent ?? "";
  expect(card(document)?.getAttribute("data-state")).toBe("done");
  expect(text).not.toContain("wait for your approval");
  expect(text).not.toContain("Wants to");
  expect(text).not.toContain("Would add");
  expect(text).toContain("Added 3 notes.");
  expect(text).toContain("Added: Ships on Fridays.");
  expect(text).toContain("You approved these changes.");
  expect(buttonNamed(document, "Approve")).toBeUndefined();
});

test("a rejected dream drops the held sentence but keeps its lines as proposals", () => {
  const document = render({
    runs: [
      run({
        counts: HELD_COUNTS,
        diary: `${HELD_DIARY}\nYou rejected these changes. Nothing was changed.`,
      }),
    ],
  });
  const text = card(document)?.textContent ?? "";
  expect(card(document)?.getAttribute("data-state")).toBe("rejected");
  expect(text).not.toContain("wait for your approval");
  expect(text).toContain("Wanted to add 3 notes.");
  expect(text).toContain("Would add: Ships on Fridays.");
  expect(text).toContain("You rejected these changes.");
});

test("an answered question says so in place of the waiting sentence, with no Needs you link", () => {
  const document = render({
    runs: [
      run({
        counts: { added: 1, dropped: 0, merged: 0, questions: 1 },
        diary:
          "Added 1 note. 1 question is waiting for you.\nAdded: Ships on Fridays.",
        openQuestions: 0,
        resultVersion: "version_1",
      }),
    ],
  });
  const text = card(document)?.textContent ?? "";
  expect(text).not.toContain("waiting for you");
  expect(text).toContain("You answered the question.");
  expect(card(document)?.querySelector("a")).toBeNull();
});

test("a question that is still open stays waiting and links to Needs you", () => {
  const document = render({
    runs: [
      run({
        counts: { added: 1, dropped: 0, merged: 0, questions: 1 },
        diary: "Added 1 note. 1 question is waiting for you.",
        openQuestions: 1,
        resultVersion: "version_1",
      }),
    ],
  });
  const text = card(document)?.textContent ?? "";
  expect(text).toContain("One question is waiting for you.");
  expect(text).not.toContain("You answered");
  expect(card(document)?.querySelector("a")?.textContent).toBe(
    "Open Needs you"
  );
});

test("an undone dream states the undo and no longer says a question waits", () => {
  const document = render({
    runs: [
      run({
        counts: { added: 1, dropped: 0, merged: 0, questions: 1 },
        diary:
          "Added 1 note. 1 question is waiting for you.\nYou undid this dream.",
        openQuestions: 0,
        resultVersion: "version_1",
        status: "undone",
      }),
    ],
  });
  const text = card(document)?.textContent ?? "";
  expect(card(document)?.getAttribute("data-state")).toBe("undone");
  expect(text).toContain(
    "You undid this night. The notes are back as they were."
  );
  expect(text).not.toContain("waiting for you");
  expect(text).not.toContain("You answered");
});
