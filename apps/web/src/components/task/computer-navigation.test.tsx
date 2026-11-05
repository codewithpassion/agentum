/** biome-ignore-all lint/suspicious/useAwait: Async act flushes effects. */
import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import type { TaskTab } from "./task-tabs.tsx";
import { useTaskComputer } from "./use-task-computer.ts";

test("#computer opens a dock or phone tab; Escape closes the dock and restores the toggle", async () => {
  const dom = new Window({ url: "http://localhost/tasks/run#computer" });
  const keys = [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Node",
    "ResizeObserver",
    "requestAnimationFrame",
    "IS_REACT_ACT_ENVIRONMENT",
  ];
  const previous = new Map(
    keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  );
  let resize: (entries: { contentRect: { width: number } }[]) => void = () =>
    undefined;
  class Observer {
    constructor(callback: typeof resize) {
      resize = callback;
    }
    observe() {
      resize([{ contentRect: { width: 960 } }]);
    }
    disconnect() {
      /* No native observer in this harness. */
    }
  }
  for (const key of keys) {
    let value = Reflect.get(dom, key);
    if (key === "ResizeObserver") {
      value = Observer;
    }
    if (key === "IS_REACT_ACT_ENVIRONMENT") {
      value = true;
    }
    if (key === "requestAnimationFrame") {
      value = (callback: () => void) => {
        callback();
        return 1;
      };
    }
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  function Harness() {
    const [selected, setSelected] = useState<TaskTab>("conversation");
    const selectTab = useCallback((tab: TaskTab) => setSelected(tab), []);
    const computer = useTaskComputer({
      machineId: "machine",
      selected,
      selectTab,
      setSelected,
      startedBy: "person",
    });
    return (
      <div ref={computer.split}>
        <button
          id="task-computer-toggle"
          onClick={computer.selectComputer}
          type="button"
        >
          Computer
        </button>
        <div
          data-open={computer.computerOpen}
          data-selected={selected}
          data-width={computer.dockWidth}
        />
        <h2 data-computer-heading tabIndex={-1}>
          Computer controls
        </h2>
      </div>
    );
  }
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<Harness />));
    expect(
      container.querySelector("[data-selected]")?.getAttribute("data-width")
    ).toBe("400");
    expect(
      container.querySelector("[data-open]")?.getAttribute("data-open")
    ).toBe("true");
    expect(
      container.querySelector("[data-selected]")?.getAttribute("data-selected")
    ).toBe("conversation");
    expect(
      dom.document.activeElement?.hasAttribute("data-computer-heading")
    ).toBe(true);
    await act(async () =>
      dom.document.dispatchEvent(
        new dom.KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
      )
    );
    expect(
      container.querySelector("[data-open]")?.getAttribute("data-open")
    ).toBe("false");
    expect(dom.document.activeElement?.id).toBe("task-computer-toggle");
    await act(async () => resize([{ contentRect: { width: 390 } }]));
    expect(
      container.querySelector("[data-selected]")?.getAttribute("data-selected")
    ).toBe("computer");
    expect(
      container.querySelector("[data-selected]")?.getAttribute("data-width")
    ).toBe(null);
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
