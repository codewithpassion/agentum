/** biome-ignore-all lint/suspicious/useAwait: Async act flushes effects. */
import { expect, test } from "bun:test";
import { type HTMLTextAreaElement, Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "#/components/ui/tooltip.tsx";
import { MentionComposer } from "./mention-composer.tsx";
import type { RoomMember } from "./room-types.ts";

const members: readonly RoomMember[] = [
  {
    avatar: { color: "blue", glyph: "F" },
    handle: "fake-echo",
    id: "a1",
    kind: "agent",
    name: "Fake echo",
  },
  { avatar: null, handle: "dom", id: "u1", kind: "user", name: "Dom Fretz" },
  { avatar: null, handle: null, id: "u2", kind: "user", name: "No Handle" },
];

const noop = () => undefined;

const GLOBAL_KEYS = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Node",
  "IS_REACT_ACT_ENVIRONMENT",
];

const mount = (dom: Window, container: Element) => {
  // StickyComposer skips its keyboard tracking when visualViewport is null.
  Object.defineProperty(dom, "visualViewport", {
    configurable: true,
    value: null,
  });
  const previous = new Map(
    GLOBAL_KEYS.map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ])
  );
  for (const key of GLOBAL_KEYS) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(dom, key),
    });
  }
  const root = createRoot(container);
  const restore = () => {
    for (const key of GLOBAL_KEYS) {
      const value = previous.get(key);
      if (value) {
        Object.defineProperty(globalThis, key, value);
      } else {
        Reflect.deleteProperty(globalThis, key);
      }
    }
  };
  return { restore, root };
};

const typeText = async (
  dom: Window,
  textarea: HTMLTextAreaElement,
  value: string
) => {
  const setValue = Object.getOwnPropertyDescriptor(
    dom.HTMLTextAreaElement.prototype,
    "value"
  )?.set;
  // React picks its input-event path when its module loads, before these
  // globals exist, so focus and keyup go first to cover the fallback path.
  const dispatch = (type: string) =>
    textarea.dispatchEvent(new dom.Event(type, { bubbles: true }));
  await act(async () => {
    dispatch("focusin");
    setValue?.call(textarea, value);
    textarea.setSelectionRange(value.length, value.length);
    dispatch("keyup");
    dispatch("input");
  });
};

const pressKey = async (
  dom: Window,
  textarea: HTMLTextAreaElement,
  key: string
) => {
  await act(async () => {
    textarea.dispatchEvent(
      new dom.KeyboardEvent("keydown", { bubbles: true, key })
    );
  });
};

test("typing @ lists the mentionable members, agents first", async () => {
  const dom = new Window();
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const { restore, root } = mount(dom, container as unknown as Element);
  try {
    await act(async () =>
      root.render(
        <TooltipProvider>
          <MentionComposer members={members} onSent={noop} threadId="t" />
        </TooltipProvider>
      )
    );
    const textarea = container.querySelector("textarea");
    if (textarea === null) {
      throw new Error("no textarea rendered");
    }
    await typeText(dom, textarea, "hi @");
    const listbox = container.querySelector('[role="listbox"]');
    const options = Array.from(container.querySelectorAll('[role="option"]'));
    expect(listbox).not.toBeNull();
    expect(
      options.map(
        (option) => option.querySelector("span.truncate")?.textContent
      )
    ).toEqual(["Fake echo", "Dom Fretz"]);
    expect(container.textContent).not.toContain("No Handle");
  } finally {
    await act(async () => root.unmount());
    restore();
    await dom.happyDOM.close();
  }
});

test("ArrowDown and Enter pick a mention and leave a trailing space", async () => {
  const dom = new Window();
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const { restore, root } = mount(dom, container as unknown as Element);
  try {
    await act(async () =>
      root.render(
        <TooltipProvider>
          <MentionComposer members={members} onSent={noop} threadId="t" />
        </TooltipProvider>
      )
    );
    const textarea = container.querySelector("textarea");
    if (textarea === null) {
      throw new Error("no textarea rendered");
    }
    await typeText(dom, textarea, "@");
    await pressKey(dom, textarea, "ArrowDown");
    await pressKey(dom, textarea, "Enter");
    expect(textarea.value).toBe("@dom ");
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    restore();
    await dom.happyDOM.close();
  }
});

test("Escape closes the list and keeps the text", async () => {
  const dom = new Window();
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const { restore, root } = mount(dom, container as unknown as Element);
  try {
    await act(async () =>
      root.render(
        <TooltipProvider>
          <MentionComposer members={members} onSent={noop} threadId="t" />
        </TooltipProvider>
      )
    );
    const textarea = container.querySelector("textarea");
    if (textarea === null) {
      throw new Error("no textarea rendered");
    }
    await typeText(dom, textarea, "hi @fa");
    await pressKey(dom, textarea, "Escape");
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(textarea.value).toBe("hi @fa");
  } finally {
    await act(async () => root.unmount());
    restore();
    await dom.happyDOM.close();
  }
});

test("text with no @ shows no list", async () => {
  const dom = new Window();
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const { restore, root } = mount(dom, container as unknown as Element);
  try {
    await act(async () =>
      root.render(
        <TooltipProvider>
          <MentionComposer members={members} onSent={noop} threadId="t" />
        </TooltipProvider>
      )
    );
    const textarea = container.querySelector("textarea");
    if (textarea === null) {
      throw new Error("no textarea rendered");
    }
    await typeText(dom, textarea, "hello there");
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    restore();
    await dom.happyDOM.close();
  }
});

test("the composer shows the dictation button and a microphone choice", async () => {
  const dom = new Window();
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const { restore, root } = mount(dom, container as unknown as Element);
  try {
    await act(async () =>
      root.render(
        <TooltipProvider>
          <MentionComposer members={members} onSent={noop} threadId="t" />
        </TooltipProvider>
      )
    );
    expect(
      container.querySelector('button[aria-label="Start dictation"]')
    ).not.toBeNull();
    expect(
      container.querySelector('button[aria-label="Choose microphone"]')
    ).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    restore();
    await dom.happyDOM.close();
  }
});
