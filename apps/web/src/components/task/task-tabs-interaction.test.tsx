/** biome-ignore-all lint/suspicious/useAwait: Async act flushes effects. */
import { expect, test } from "bun:test";
import { type HTMLButtonElement, Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { type TaskTab, TaskTabs } from "./task-tabs.tsx";

test("tab arrows move focus without activation; Enter opens the focused tab", async () => {
  const dom = new Window({ height: 844, width: 390 });
  const keys = [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Node",
    "IS_REACT_ACT_ENVIRONMENT",
  ];
  const previous = new Map(
    keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  );
  for (const key of keys) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(dom, key),
    });
  }
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container as unknown as Element);
  let chosen: TaskTab = "conversation";
  const select = (tab: TaskTab) => {
    chosen = tab;
  };
  try {
    await act(async () =>
      root.render(
        <TaskTabs
          computer={true}
          conflict={true}
          files={0}
          log={0}
          mail={2}
          onSelect={select}
          pending={true}
          selected="conversation"
        />
      )
    );
    const tabs = container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect(tabs.length).toBe(5);
    await act(async () => {
      tabs[0]?.focus();
      tabs[0]?.dispatchEvent(
        new dom.KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })
      );
    });
    expect(dom.document.activeElement === tabs[1]).toBe(true);
    expect(chosen).toBe("conversation");
    expect(tabs[1]?.tabIndex).toBe(0);
    // A button's native Enter/Space activation dispatches click.
    await act(async () => tabs[1]?.click());
    expect(chosen as string).toBe("files");
    await act(async () =>
      tabs[1]?.dispatchEvent(
        new dom.KeyboardEvent("keydown", { bubbles: true, key: "End" })
      )
    );
    expect(dom.document.activeElement === tabs[4]).toBe(true);
    await act(async () =>
      tabs[4]?.dispatchEvent(
        new dom.KeyboardEvent("keydown", { bubbles: true, key: "Home" })
      )
    );
    expect(dom.document.activeElement === tabs[0]).toBe(true);
  } finally {
    await act(async () => root.unmount());
    for (const key of keys) {
      const descriptor = previous.get(key);
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, key);
      }
    }
    await dom.happyDOM.close();
  }
});
