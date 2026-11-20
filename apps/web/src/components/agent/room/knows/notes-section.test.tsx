import { expect, test } from "bun:test";
import type { MemoryChange, MemoryNote, MemoryNoteKind } from "@repo/db/shared";
import { Window } from "happy-dom";
import type { ReactElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderInRoom } from "../test-fixtures.tsx";
import { groupNotes } from "./notes-logic.ts";
import { NotesSection } from "./notes-section.tsx";

const noop = (): void => undefined;

const note = (overrides: Partial<MemoryNote> = {}): MemoryNote => ({
  date: "2026-11-11",
  id: "note_1",
  kind: "people",
  source: null,
  text: "Prefers short replies",
  userScope: null,
  writtenBy: "person",
  ...overrides,
});

const held = (overrides: Partial<MemoryChange> = {}): MemoryChange => ({
  action: "add",
  agentId: "agent_1",
  createdAt: "2026-11-11T09:00:00.000Z",
  decidedAt: null,
  decidedBy: null,
  dreamRunId: null,
  groupId: null,
  id: "change_1",
  kind: "corrections",
  libraryVersionId: null,
  noteId: "note_2",
  source: null,
  status: "held",
  teamId: null,
  text: "Call the client Sam, not Samuel",
  userScope: null,
  writtenBy: "agent",
  ...overrides,
});

const sectionProps = {
  adding: false,
  busyId: null,
  disabled: false,
  groups: [],
  onAdd: noop,
  onDecide: noop,
  onEdit: noop,
  onForget: noop,
};

type TestDocument = Window["document"];
type TestElement = NonNullable<ReturnType<TestDocument["querySelector"]>>;

const render = (element: ReactElement): TestDocument => {
  const { document } = new Window();
  document.body.innerHTML = renderInRoom(element);
  return document;
};

const buttonNamed = (
  scope: TestDocument | TestElement | null | undefined,
  name: string
) =>
  Array.from(scope?.querySelectorAll("button") ?? []).find(
    (button) => (button.textContent ?? "").trim() === name
  );

const addButton = (document: TestDocument) => buttonNamed(document, "Add note");

test("no groups says nothing is remembered and still shows the Add form", () => {
  const document = render(<NotesSection {...sectionProps} />);
  expect(document.body.textContent).toContain("Nothing remembered yet.");
  expect(addButton(document)).toBeDefined();
  expect(document.querySelector("form")).not.toBeNull();
});

test("group headings come in the given order, and a held row sits before the notes of its group", () => {
  const groups = groupNotes(
    [
      note({ id: "note_1", kind: "people", text: "Sam is in Berlin" }),
      note({ id: "note_2", kind: "corrections", text: "Use metric units" }),
    ],
    [held({ id: "change_1", kind: "corrections" })]
  );
  const html = renderInRoom(<NotesSection {...sectionProps} groups={groups} />);
  const document = render(<NotesSection {...sectionProps} groups={groups} />);
  const headings = Array.from(document.querySelectorAll("h3")).map(
    (heading) => heading.textContent
  );
  expect(headings).toEqual(groups.map((group) => group.label));

  const correctionsAt = html.indexOf(">Corrections</h3>");
  const heldAt = html.indexOf('data-testid="held-row"', correctionsAt);
  const noteAt = html.indexOf('data-testid="note-row"', correctionsAt);
  expect(correctionsAt).toBeGreaterThan(-1);
  expect(heldAt).toBeGreaterThan(-1);
  expect(heldAt).toBeLessThan(noteAt);
});

test("a busy id disables only the row it belongs to", () => {
  const groups = groupNotes(
    [
      note({ id: "note_a", text: "First note" }),
      note({ date: "2026-11-10", id: "note_b", text: "Second note" }),
    ],
    [held({ id: "change_9", kind: "people" })]
  );

  const notesBusy = render(
    <NotesSection {...sectionProps} busyId="note_b" groups={groups} />
  );
  const [first, second] = Array.from(
    notesBusy.querySelectorAll('[data-testid="note-row"]')
  );
  expect(buttonNamed(first, "Edit")?.disabled).toBe(false);
  expect(buttonNamed(first, "Forget")?.disabled).toBe(false);
  expect(buttonNamed(second, "Edit")?.disabled).toBe(true);
  expect(buttonNamed(second, "Forget")?.disabled).toBe(true);

  const heldBusy = render(
    <NotesSection {...sectionProps} busyId="change_9" groups={groups} />
  );
  const heldRow = heldBusy.querySelector('[data-testid="held-row"]');
  const noteRow = heldBusy.querySelector('[data-testid="note-row"]');
  expect(buttonNamed(heldRow, "Approve")?.disabled).toBe(true);
  expect(buttonNamed(heldRow, "Reject")?.disabled).toBe(true);
  expect(buttonNamed(noteRow, "Edit")?.disabled).toBe(false);
});

test("disabled disables the Add button, the kind select and the note input", () => {
  const document = render(<NotesSection {...sectionProps} disabled={true} />);
  expect(addButton(document)?.disabled).toBe(true);
  expect(document.querySelector("select")?.disabled).toBe(true);
  expect(document.querySelector("input")?.disabled).toBe(true);
});

test("the kind select offers the four kind labels", () => {
  const document = render(<NotesSection {...sectionProps} />);
  const options = Array.from(document.querySelectorAll("select option")).map(
    (option) => option.textContent
  );
  expect(options).toEqual([
    "About people",
    "Corrections",
    "Work in progress",
    "Where things are",
  ]);
});

test("typing a note and submitting calls onAdd with the kind and trimmed text, then clears the input", async () => {
  const dom = new Window({ url: "http://localhost/" });
  const previous = {
    document: globalThis.document,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as Record<string, unknown>)
      .IS_REACT_ACT_ENVIRONMENT,
    window: globalThis.window,
  };
  Object.assign(globalThis, {
    document: dom.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom,
  });
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container as unknown as Element);
  const added: [MemoryNoteKind, string][] = [];
  const onAdd = (kind: MemoryNoteKind, text: string): void => {
    added.push([kind, text]);
  };
  try {
    await act(async () =>
      root.render(<NotesSection {...sectionProps} onAdd={onAdd} />)
    );
    const select = container.querySelector("select");
    const input = container.querySelector("input");
    if (select === null || input === null) {
      throw new Error("The Add form controls did not render");
    }
    const setValue = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(input),
      "value"
    )?.set;
    act(() => {
      select.value = "corrections";
      select.dispatchEvent(new dom.Event("change", { bubbles: true }));
      input.focus();
      setValue?.call(input, "  Call the client Sam  ");
      input.dispatchEvent(
        new dom.KeyboardEvent("keyup", { bubbles: true, key: "a" })
      );
    });
    act(() => {
      container
        .querySelector("form")
        ?.dispatchEvent(
          new dom.Event("submit", { bubbles: true, cancelable: true })
        );
    });

    expect(added).toEqual([["corrections", "Call the client Sam"]]);
    expect(container.querySelector("input")?.value).toBe("");
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
  }
});
