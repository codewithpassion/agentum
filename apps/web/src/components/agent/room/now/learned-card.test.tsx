import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import type { MemoryChange } from "@repo/db/shared";
import {
  type HTMLButtonElement as DomButton,
  type HTMLElement as DomElement,
  Window,
} from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { changeSentence } from "../knows/learned-logic.ts";
import { LearnedCard } from "./learned-slot.tsx";

// Learned this week reads Clerk's auth state through LearnedSlot, which needs a provider.
mock.module("@clerk/tanstack-react-start", () => ({
  useAuth: () => ({ orgRole: "org:admin", userId: "user_1" }),
}));

const dom = new Window({ url: "https://preview.agentum.test" });
const previous = new Map<string, PropertyDescriptor | undefined>();
const globalKeys = ["window", "document", "IS_REACT_ACT_ENVIRONMENT"];

const NOW_MS = new Date(2026, 10, 20, 12, 0, 0).getTime();
const TODAY_ISO = new Date(2026, 10, 20, 8, 0, 0).toISOString();

function makeChange(overrides: Partial<MemoryChange>): MemoryChange {
  return {
    action: "add",
    agentId: "agent-1",
    createdAt: TODAY_ISO,
    decidedAt: null,
    decidedBy: null,
    dreamRunId: null,
    groupId: null,
    id: "c1",
    kind: "people",
    libraryVersionId: null,
    noteId: "n1",
    source: null,
    status: "applied",
    teamId: null,
    text: "Likes short emails",
    userScope: null,
    writtenBy: "person",
    ...overrides,
  };
}

/** Changes c1..cN, newest first, each with its own sentence. */
function makeChanges(count: number): MemoryChange[] {
  return Array.from({ length: count }, (_, index) =>
    makeChange({ id: `c${index + 1}`, text: `Fact number ${index + 1}` })
  );
}

beforeAll(() => {
  const values: Record<string, unknown> = {
    document: dom.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom,
  };
  for (const key of globalKeys) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: values[key],
    });
  }
});

afterAll(() => {
  for (const [key, descriptor] of previous) {
    if (descriptor) {
      Object.defineProperty(globalThis, key, descriptor);
    } else {
      Reflect.deleteProperty(globalThis, key);
    }
  }
});

async function mountCard(
  changes: MemoryChange[],
  onUndo: (changeId: string) => void = () => undefined
) {
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container as unknown as Element);
  await act(async () =>
    root.render(
      <LearnedCard
        busyId={null}
        canChange={true}
        changes={changes}
        disabled={false}
        nowMs={NOW_MS}
        onUndo={onUndo}
      />
    )
  );
  const unmount = async (): Promise<void> => {
    await act(async () => root.unmount());
    container.remove();
  };
  return { container, unmount };
}

function rows(container: DomElement): DomElement[] {
  return Array.from(
    container.querySelectorAll<DomElement>('[data-testid="learned-row"]')
  );
}

function buttonNamed(container: DomElement, name: string) {
  return Array.from(container.querySelectorAll("button")).find(
    (button) => (button.textContent ?? "").trim() === name
  );
}

function requireButton(container: DomElement, name: string): DomButton {
  const button = buttonNamed(container, name);
  if (!(button instanceof dom.HTMLButtonElement)) {
    throw new Error(`The "${name}" button is missing`);
  }
  return button;
}

test("six changes show the newest three rows and a Show all (6) button", async () => {
  const { container, unmount } = await mountCard(makeChanges(6));
  try {
    expect(rows(container)).toHaveLength(3);
    expect(rows(container)[0]?.textContent).toContain("Fact number 1");
    expect(rows(container)[2]?.textContent).toContain("Fact number 3");
    const button = requireButton(container, "Show all (6)");
    expect(button.getAttribute("aria-expanded")).toBe("false");
  } finally {
    await unmount();
  }
});

test("clicking Show all shows every row and reads Show less, and clicking again folds back to three", async () => {
  const { container, unmount } = await mountCard(makeChanges(6));
  try {
    await act(async () => requireButton(container, "Show all (6)").click());
    expect(rows(container)).toHaveLength(6);
    const expandedButton = requireButton(container, "Show less");
    expect(expandedButton.getAttribute("aria-expanded")).toBe("true");

    await act(async () => expandedButton.click());
    expect(rows(container)).toHaveLength(3);
    expect(buttonNamed(container, "Show all (6)")).toBeDefined();
  } finally {
    await unmount();
  }
});

test("three changes show no Show all button", async () => {
  const { container, unmount } = await mountCard(makeChanges(3));
  try {
    expect(rows(container)).toHaveLength(3);
    expect(buttonNamed(container, "Show all (3)")).toBeUndefined();
    expect(buttonNamed(container, "Show less")).toBeUndefined();
  } finally {
    await unmount();
  }
});

test("each row's text carries the full sentence in its title", async () => {
  const changes = makeChanges(4);
  const { container, unmount } = await mountCard(changes);
  try {
    const titles = rows(container).map((row) => {
      const text = row.querySelector("span");
      return { className: text?.className, title: text?.getAttribute("title") };
    });
    expect(titles).toEqual(
      changes.slice(0, 3).map((change) => ({
        className: "line-clamp-3 min-w-0",
        title: changeSentence(change),
      }))
    );
  } finally {
    await unmount();
  }
});

test("clicking Undo calls onUndo with the change id", async () => {
  const undone: string[] = [];
  const { container, unmount } = await mountCard(makeChanges(2), (changeId) =>
    undone.push(changeId)
  );
  try {
    const undoButtons = Array.from(container.querySelectorAll("button")).filter(
      (button) => (button.textContent ?? "").trim() === "Undo"
    );
    expect(undoButtons).toHaveLength(2);
    await act(async () => undoButtons[1]?.click());
    expect(undone).toEqual(["c2"]);
  } finally {
    await unmount();
  }
});
