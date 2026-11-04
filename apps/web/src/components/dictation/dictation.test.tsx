/** biome-ignore-all lint/performance/noJsxPropsBind: React interaction harness. */
/** biome-ignore-all lint/suspicious/useAwait: act flushes React effects. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "#/components/ui/tooltip.tsx";
import type { Capture, StartCapture } from "./capture.ts";
import {
  type DictationAdapter,
  DictationButton,
  DictationPreview,
  useDictation,
} from "./index.ts";

const dom = new Window({ url: "http://localhost" });
const previous = new Map<string, PropertyDescriptor | undefined>();
const keys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "MutationObserver",
  "localStorage",
  "Node",
  "getComputedStyle",
  "requestAnimationFrame",
  "IS_REACT_ACT_ENVIRONMENT",
];
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
  for (const [key, value] of previous) {
    if (value) {
      Object.defineProperty(globalThis, key, value);
    } else {
      Reflect.deleteProperty(globalThis, key);
    }
  }
});
let state: ReturnType<typeof useDictation>;
let stops = 0;
const capture = async (
  onSamples: (samples: Float32Array) => void
): Promise<Capture> => {
  onSamples(new Float32Array(1600).fill(0.2));
  return {
    devices: [],
    stop: () => {
      stops += 1;
    },
  };
};
const defaultAdapter: DictationAdapter = {
  polish: async () => ({ text: "Hello." }),
  status: async () => ({ available: true }),
  transcribe: async () => ({ text: "hello" }),
};
interface HarnessProps {
  adapter?: DictationAdapter;
  captureInput?: StartCapture;
}
function Harness({
  adapter = defaultAdapter,
  captureInput = capture,
}: HarnessProps) {
  const [value, setValue] = useState("before after");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  state = useDictation({
    adapter,
    capture: captureInput,
    getValue: () => value,
    inputRef,
    setValue,
  });
  return (
    <>
      <textarea
        onChange={() => undefined}
        readOnly={state.busy}
        ref={inputRef}
        value={value}
      />
      <DictationPreview dictation={state} />
      <TooltipProvider>
        <DictationButton dictation={state} />
      </TooltipProvider>
    </>
  );
}
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
const mount = async (props: HarnessProps = {}) => {
  const node = document.createElement("div");
  document.body.appendChild(node);
  const root = createRoot(node as unknown as Element);
  await act(async () => root.render(<Harness {...props} />));
  await settle();
  const input = node.querySelector("textarea");
  if (!input) {
    throw new Error("Missing textarea");
  }
  input.focus();
  input.setSelectionRange(7, 7);
  return { input, node, root };
};
test("click toggles, preview is muted italic and polished text inserts at caret", async () => {
  const { node, input, root } = await mount();
  await act(async () => {
    state.press();
    state.release();
  });
  await settle();
  expect(state.busy).toBe(true);
  expect(input.readOnly).toBe(true);
  expect(node.querySelector(".text-muted-foreground.italic")).not.toBeNull();
  await act(async () => {
    state.press();
    state.release();
  });
  await settle();
  expect(input.value).toBe("before Hello.after");
  expect(state.busy).toBe(false);
  await act(async () => root.unmount());
});
test("250ms hold is push to talk; Escape cancels", async () => {
  const { input, root } = await mount();
  await act(async () => state.press());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 260));
  });
  expect(state.busy).toBe(true);
  await act(async () => state.release());
  await settle();
  expect(state.busy).toBe(false);
  await act(async () => {
    state.press();
    state.release();
  });
  await settle();
  await act(async () =>
    input.dispatchEvent(
      new dom.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }) as unknown as Event
    )
  );
  await settle();
  expect(state.busy).toBe(false);
  expect(stops).toBeGreaterThan(0);
  await act(async () => root.unmount());
});
test("Ctrl+D tap and hold ignore auto repeat", async () => {
  const { input, root } = await mount();
  const key = (type: string, repeat = false) =>
    input.dispatchEvent(
      new dom.KeyboardEvent(type, {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        key: "d",
        repeat,
      }) as unknown as Event
    );
  await act(async () => {
    key("keydown");
    key("keydown", true);
    key("keyup");
  });
  await settle();
  expect(state.busy).toBe(true);
  await act(async () => {
    key("keydown");
    key("keyup");
  });
  await settle();
  expect(state.busy).toBe(false);
  await act(async () => key("keydown"));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 260));
    key("keydown", true);
  });
  expect(state.busy).toBe(true);
  await act(async () => key("keyup"));
  await settle();
  expect(state.busy).toBe(false);
  await act(async () => root.unmount());
});

test("actual mic button clicks toggle and pointer hold stops on release", async () => {
  const { node, root } = await mount();
  const button = node.querySelector<HTMLButtonElement>(
    'button[aria-label="Start dictation"]'
  );
  if (!button) {
    throw new Error("Missing mic");
  }
  await act(async () => button.click());
  await settle();
  expect(state.busy).toBe(true);
  await act(async () => button.click());
  await settle();
  expect(state.busy).toBe(false);
  button.setPointerCapture = () => undefined;
  await act(async () =>
    button.dispatchEvent(
      new dom.PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        pointerId: 1,
      }) as unknown as Event
    )
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 260));
  });
  expect(state.busy).toBe(true);
  await act(async () =>
    button.dispatchEvent(
      new dom.PointerEvent("pointerup", {
        bubbles: true,
        button: 0,
        pointerId: 1,
      }) as unknown as Event
    )
  );
  await settle();
  expect(state.busy).toBe(false);
  await act(async () => root.unmount());
});
test("no key disables mic and directs to Model providers", async () => {
  const { node, root } = await mount({
    adapter: { ...defaultAdapter, status: async () => ({ available: false }) },
  });
  const button = node.querySelector<HTMLButtonElement>(
    'button[aria-label="Start dictation"]'
  );
  expect(button?.disabled).toBe(true);
  expect(button?.parentElement?.title).toContain("Settings, Model providers");
  await act(async () => root.unmount());
});
test("Escape during polishing discards late response without inserting", async () => {
  let resolvePolish: (value: { text: string }) => void = () => undefined;
  const { input, root } = await mount({
    adapter: {
      ...defaultAdapter,
      polish: () =>
        new Promise((resolve) => {
          resolvePolish = resolve;
        }),
    },
  });
  await act(async () => {
    state.press();
    state.release();
  });
  await settle();
  await act(async () => {
    state.press();
    state.release();
  });
  await settle();
  expect(state.phase).toBe("polishing");
  await act(async () =>
    input.dispatchEvent(
      new dom.KeyboardEvent("keydown", {
        bubbles: true,
        key: "Escape",
      }) as unknown as Event
    )
  );
  await act(async () => resolvePolish({ text: "Hello." }));
  await settle();
  expect(input.value).toBe("before after");
  expect(state.preview).toBe("");
  expect(state.busy).toBe(false);
  await act(async () => root.unmount());
});
test("cancel during microphone permission stops the late stream", async () => {
  let resolveCapture: (capture: Capture) => void = () => undefined;
  let stopped = 0;
  const { input, root } = await mount({
    captureInput: () =>
      new Promise((resolve) => {
        resolveCapture = resolve;
      }),
  });
  await act(async () => {
    state.press();
    state.release();
  });
  await settle();
  expect(state.phase).toBe("starting");
  await act(async () => state.cancel());
  await act(async () =>
    resolveCapture({
      devices: [],
      stop: () => {
        stopped += 1;
      },
    })
  );
  await settle();
  expect(stopped).toBe(1);
  expect(input.value).toBe("before after");
  expect(state.busy).toBe(false);
  await act(async () => root.unmount());
});
test("raw transcription survives polish failure", async () => {
  const { input, root } = await mount({
    adapter: {
      ...defaultAdapter,
      polish: () => Promise.reject(new Error("failed")),
    },
  });
  await act(async () => {
    state.press();
    state.release();
  });
  await settle();
  await act(async () => {
    state.press();
    state.release();
  });
  await settle();
  expect(input.value).toBe("before helloafter");
  await act(async () => root.unmount());
});

test("final segments stay in speech order even when responses arrive backwards", async () => {
  let push: (samples: Float32Array) => void = () => undefined;
  const finals: ((text: { text: string }) => void)[] = [];
  const { input, root } = await mount({
    adapter: {
      ...defaultAdapter,
      polish: async ({ text }) => ({ text }),
      transcribe: () =>
        new Promise((resolve) => {
          finals.push(resolve);
        }),
    },
    captureInput: async (samples) => {
      push = samples;
      return { devices: [], stop: () => undefined };
    },
  });
  await act(async () => {
    state.press();
    state.release();
  });
  await settle();
  const segment = () => {
    push(new Float32Array(1600).fill(0.2));
    push(new Float32Array(11_200));
  };
  await act(async () => {
    segment();
    segment();
  });
  expect(finals).toHaveLength(2);
  await act(async () => {
    state.press();
    state.release();
  });
  await settle();
  expect(state.phase).toBe("finishing");
  await act(async () => finals[1]?.({ text: "second" }));
  await act(async () => finals[0]?.({ text: "first" }));
  await settle();
  expect(input.value).toBe("before first secondafter");
  await act(async () => root.unmount());
});
test("only one interim is in flight and obsolete interim failure cannot cancel polishing", async () => {
  let rejectInterim: () => void = () => undefined;
  let interimCalls = 0;
  let resolvePolish: (value: { text: string }) => void = () => undefined;
  const { input, root } = await mount({
    adapter: {
      ...defaultAdapter,
      polish: () =>
        new Promise((resolve) => {
          resolvePolish = resolve;
        }),
      transcribe: ({ final }) => {
        if (final) {
          return Promise.resolve({ text: "hello" });
        }
        interimCalls += 1;
        return new Promise((_resolve, reject) => {
          rejectInterim = () => reject(new Error("obsolete interim"));
        });
      },
    },
  });
  await act(async () => {
    state.press();
    state.release();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 2100));
  });
  expect(interimCalls).toBe(1);
  await act(async () => {
    state.press();
    state.release();
  });
  await settle();
  expect(state.phase).toBe("polishing");
  await act(async () => rejectInterim());
  await settle();
  expect(state.phase).toBe("polishing");
  await act(async () => resolvePolish({ text: "Hello." }));
  await settle();
  expect(input.value).toBe("before Hello.after");
  await act(async () => root.unmount());
});

test("preview makes room at a mid-text caret and restores input glyphs on cancel", async () => {
  const { node, input, root } = await mount();
  const original = input.style.color;
  await act(async () => {
    state.press();
    state.release();
  });
  await settle();
  expect(input.style.color).toBe("transparent");
  expect(
    node.querySelector('[data-dictation-existing="prefix"]')?.textContent
  ).toBe("before ");
  expect(
    node.querySelector('[data-dictation-existing="suffix"]')?.textContent
  ).toBe("after");
  await act(async () => state.cancel());
  expect(input.style.color).toBe(original);
  await act(async () => root.unmount());
});
