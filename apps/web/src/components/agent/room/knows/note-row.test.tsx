import { expect, test } from "bun:test";
import type { MemoryChange, MemoryNote } from "@repo/db/shared";
import { Window } from "happy-dom";
import type { ReactElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderInRoom } from "../test-fixtures.tsx";
import { HeldRow, NoteRow } from "./note-row.tsx";

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
  kind: "people",
  libraryVersionId: null,
  noteId: "note_1",
  source: null,
  status: "held",
  teamId: null,
  text: "Prefers short replies",
  userScope: null,
  writtenBy: "agent",
  ...overrides,
});

type TestDocument = Window["document"];

const render = (element: ReactElement): TestDocument => {
  const { document } = new Window();
  document.body.innerHTML = renderInRoom(element);
  return document;
};

const buttonNamed = (document: TestDocument, name: string) =>
  Array.from(document.querySelectorAll("button")).find(
    (button) => (button.textContent ?? "").trim() === name
  );

test("a person note with no source says it was added by hand, with its date and the buttons", () => {
  const document = render(
    <NoteRow
      busy={false}
      canChange={true}
      disabled={false}
      note={note()}
      onEdit={noop}
      onForget={noop}
    />
  );
  const row = document.querySelector('[data-testid="note-row"]');
  expect(row?.textContent).toContain("Prefers short replies");
  expect(row?.textContent).toContain("Added by hand");
  expect(row?.textContent).toContain("11 Nov");
  expect(row?.querySelector("a")).toBeNull();
  expect(buttonNamed(document, "Edit")).toBeDefined();
  expect(buttonNamed(document, "Forget")).toBeDefined();
});

test("a session source links to its conversation", () => {
  const document = render(
    <NoteRow
      busy={false}
      canChange={true}
      disabled={false}
      note={note({
        source: { id: "sess_9", kind: "session" },
        writtenBy: "agent",
      })}
      onEdit={noop}
      onForget={noop}
    />
  );
  const link = document.querySelector("a");
  expect(link?.getAttribute("href")).toContain("/threads/sess_9");
  expect(link?.textContent).toBe("a conversation");
  expect(
    document.querySelector('[data-testid="note-row"]')?.textContent
  ).toContain("Noticed in");
});

test("a run source links to its task", () => {
  const document = render(
    <NoteRow
      busy={false}
      canChange={true}
      disabled={false}
      note={note({ source: { id: "run_4", kind: "run" } })}
      onEdit={noop}
      onForget={noop}
    />
  );
  expect(document.querySelector("a")?.getAttribute("href")).toContain(
    "/tasks/run_4"
  );
});

test("a request source links to the desk", () => {
  const document = render(
    <NoteRow
      busy={false}
      canChange={true}
      disabled={false}
      note={note({ source: { id: "req_2", kind: "request" } })}
      onEdit={noop}
      onForget={noop}
    />
  );
  expect(document.querySelector("a")?.getAttribute("href")).toContain("/desk");
});

test("a private note shows the Private marker", () => {
  const document = render(
    <NoteRow
      busy={false}
      canChange={true}
      disabled={false}
      note={note({ userScope: "user_1" })}
      onEdit={noop}
      onForget={noop}
    />
  );
  const marker = document.querySelector('[data-testid="private-marker"]');
  expect(marker?.textContent).toBe("Private");
});

test("a shared note shows no Private marker", () => {
  const document = render(
    <NoteRow
      busy={false}
      canChange={true}
      disabled={false}
      note={note({ userScope: null })}
      onEdit={noop}
      onForget={noop}
    />
  );
  expect(document.querySelector('[data-testid="private-marker"]')).toBeNull();
});

test("a held private change shows the Private marker", () => {
  const document = render(
    <HeldRow
      busy={false}
      canChange={true}
      change={held({ userScope: "user_1" })}
      disabled={false}
      onDecide={noop}
    />
  );
  expect(
    document.querySelector('[data-testid="private-marker"]')?.textContent
  ).toBe("Private");
});

test("a held shared change shows no Private marker", () => {
  const document = render(
    <HeldRow
      busy={false}
      canChange={true}
      change={held({ userScope: null })}
      disabled={false}
      onDecide={noop}
    />
  );
  expect(document.querySelector('[data-testid="private-marker"]')).toBeNull();
});

test("a disabled note row disables Edit and Forget", () => {
  const document = render(
    <NoteRow
      busy={false}
      canChange={true}
      disabled={true}
      note={note()}
      onEdit={noop}
      onForget={noop}
    />
  );
  expect(buttonNamed(document, "Edit")?.disabled).toBe(true);
  expect(buttonNamed(document, "Forget")?.disabled).toBe(true);
});

test("a busy note row disables Edit and Forget", () => {
  const document = render(
    <NoteRow
      busy={true}
      canChange={true}
      disabled={false}
      note={note()}
      onEdit={noop}
      onForget={noop}
    />
  );
  expect(buttonNamed(document, "Edit")?.disabled).toBe(true);
  expect(buttonNamed(document, "Forget")?.disabled).toBe(true);
});

test("a non-owner sees no Edit or Forget on a shared note, and no empty button row", () => {
  const document = render(
    <NoteRow
      busy={false}
      canChange={false}
      disabled={false}
      note={note({ userScope: null })}
      onEdit={noop}
      onForget={noop}
    />
  );
  const row = document.querySelector('[data-testid="note-row"]');
  expect(row?.textContent).toContain("Prefers short replies");
  expect(buttonNamed(document, "Edit")).toBeUndefined();
  expect(buttonNamed(document, "Forget")).toBeUndefined();
  expect(row?.querySelectorAll("button").length).toBe(0);
});

test("a non-owner keeps Edit and Forget on their own private note", () => {
  const document = render(
    <NoteRow
      busy={false}
      canChange={false}
      disabled={false}
      note={note({ userScope: "user_1" })}
      onEdit={noop}
      onForget={noop}
    />
  );
  expect(buttonNamed(document, "Edit")?.disabled).toBe(false);
  expect(buttonNamed(document, "Forget")?.disabled).toBe(false);
});

test("an owner sees Edit and Forget on a shared note", () => {
  const document = render(
    <NoteRow
      busy={false}
      canChange={true}
      disabled={false}
      note={note({ userScope: null })}
      onEdit={noop}
      onForget={noop}
    />
  );
  expect(buttonNamed(document, "Edit")).toBeDefined();
  expect(buttonNamed(document, "Forget")).toBeDefined();
});

test("a held add says it wants to remember, shows the text, and offers Approve and Reject", () => {
  const document = render(
    <HeldRow
      busy={false}
      canChange={true}
      change={held()}
      disabled={false}
      onDecide={noop}
    />
  );
  const row = document.querySelector('[data-testid="held-row"]');
  expect(row?.textContent).toContain("Wants to remember");
  expect(row?.textContent).toContain("Prefers short replies");
  expect(row?.textContent).toContain("Waiting for you");
  expect(row?.textContent).toContain("The agent");
  expect(buttonNamed(document, "Approve")?.disabled).toBe(false);
  expect(buttonNamed(document, "Reject")?.disabled).toBe(false);
});

test("Approve and Reject are disabled when the held row is disabled or busy", () => {
  const disabled = render(
    <HeldRow
      busy={false}
      canChange={true}
      change={held()}
      disabled={true}
      onDecide={noop}
    />
  );
  const busy = render(
    <HeldRow
      busy={true}
      canChange={true}
      change={held()}
      disabled={false}
      onDecide={noop}
    />
  );
  expect(buttonNamed(disabled, "Approve")?.disabled).toBe(true);
  expect(buttonNamed(disabled, "Reject")?.disabled).toBe(true);
  expect(buttonNamed(busy, "Approve")?.disabled).toBe(true);
  expect(buttonNamed(busy, "Reject")?.disabled).toBe(true);
});

test("a non-owner sees no Approve or Reject on a shared held change, and keeps the rest of the row", () => {
  const document = render(
    <HeldRow
      busy={false}
      canChange={false}
      change={held({ userScope: null })}
      disabled={false}
      onDecide={noop}
    />
  );
  const row = document.querySelector('[data-testid="held-row"]');
  expect(row?.textContent).toContain("Wants to remember");
  expect(row?.textContent).toContain("Prefers short replies");
  expect(row?.textContent).toContain("Waiting for you");
  expect(buttonNamed(document, "Approve")).toBeUndefined();
  expect(buttonNamed(document, "Reject")).toBeUndefined();
  expect(row?.querySelectorAll("button").length).toBe(0);
});

test("a non-owner keeps Approve and Reject on their own private held change", () => {
  const document = render(
    <HeldRow
      busy={false}
      canChange={false}
      change={held({ userScope: "user_1" })}
      disabled={false}
      onDecide={noop}
    />
  );
  expect(buttonNamed(document, "Approve")?.disabled).toBe(false);
  expect(buttonNamed(document, "Reject")?.disabled).toBe(false);
});

test("an owner sees Approve and Reject on a shared held change", () => {
  const document = render(
    <HeldRow
      busy={false}
      canChange={true}
      change={held({ userScope: null })}
      disabled={false}
      onDecide={noop}
    />
  );
  expect(buttonNamed(document, "Approve")).toBeDefined();
  expect(buttonNamed(document, "Reject")).toBeDefined();
});

test("a held edit and a held forget name their own heading", () => {
  const edit = render(
    <HeldRow
      busy={false}
      canChange={true}
      change={held({ action: "edit" })}
      disabled={false}
      onDecide={noop}
    />
  );
  const forget = render(
    <HeldRow
      busy={false}
      canChange={true}
      change={held({ action: "forget", writtenBy: "dream" })}
      disabled={false}
      onDecide={noop}
    />
  );
  expect(edit.querySelector('[data-testid="held-row"]')?.textContent).toContain(
    "Wants to change a note to"
  );
  expect(
    forget.querySelector('[data-testid="held-row"]')?.textContent
  ).toContain("Wants to forget");
  expect(
    forget.querySelector('[data-testid="held-row"]')?.textContent
  ).toContain("A dream");
});

test("Edit opens the text, and Save sends the trimmed text to onEdit", async () => {
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
  const saved: [string, string][] = [];
  const onEdit = (noteId: string, text: string): void => {
    saved.push([noteId, text]);
  };
  const buttonWithText = (label: string) =>
    Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === label
    );
  try {
    await act(async () =>
      root.render(
        <NoteRow
          busy={false}
          canChange={true}
          disabled={false}
          note={note()}
          onEdit={onEdit}
          onForget={noop}
        />
      )
    );
    await act(async () => buttonWithText("Edit")?.click());
    const textarea = container.querySelector("textarea");
    if (textarea === null) {
      throw new Error("Edit did not open a textarea");
    }
    expect(textarea.value).toBe("Prefers short replies");

    const setValue = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(textarea),
      "value"
    )?.set;
    act(() => {
      textarea.focus();
      setValue?.call(textarea, "  Prefers long replies  ");
      textarea.dispatchEvent(
        new dom.KeyboardEvent("keyup", { bubbles: true, key: "a" })
      );
    });
    expect(buttonWithText("Save")?.disabled).toBe(false);
    await act(async () => buttonWithText("Save")?.click());

    expect(saved).toEqual([["note_1", "Prefers long replies"]]);
    expect(container.querySelector("textarea")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
  }
});
