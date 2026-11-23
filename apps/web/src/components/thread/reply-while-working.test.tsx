/** biome-ignore-all lint/suspicious/useAwait: Async act flushes effects. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ThreadMessageLike } from "@assistant-ui/react";
import type { ThreadMessage } from "@repo/protocol/thread";
import { Window } from "happy-dom";
import { act } from "react";

const dom = new Window({ url: "http://localhost" });
const previous = new Map<string, PropertyDescriptor | undefined>();
for (const key of [
  "Event",
  "CustomEvent",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "NodeFilter",
  "DOMRect",
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
  "cancelAnimationFrame",
  "IS_REACT_ACT_ENVIRONMENT",
]) {
  previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(dom, key),
  });
}

const { AssistantRuntimeProvider, ThreadPrimitive, useExternalStoreRuntime } =
  await import("@assistant-ui/react");
const { createRoot } = await import("react-dom/client");
const { BottomBar } = await import("./bottom-bar.tsx");
const { ComposerContainer } = await import("./composer-container.tsx");
const { busyNote } = await import("./thread-send.ts");
const { TooltipProvider } = await import("#/components/ui/tooltip");
const { AssistantMessageContainer } = await import(
  "./assistant-message-container.tsx"
);
const { UserMessageContainer } = await import("./user-message-container.tsx");
const { ThreadEnvProvider } = await import("./thread-context.tsx");
const { toThreadMessageLike } = await import("./thread-parts.ts");
const { threadActivity, waitingMessages, withoutWaitingTurns } = await import(
  "./thread-activity.ts"
);

afterAll(() => {
  for (const [key, value] of previous) {
    if (value) {
      Object.defineProperty(globalThis, key, value);
    } else {
      Reflect.deleteProperty(globalThis, key);
    }
  }
});

const noop = () => undefined;
const done = () => Promise.resolve();

beforeAll(() => {
  Object.defineProperty(dom, "visualViewport", {
    configurable: true,
    value: null,
  });
});

function WorkingThread({
  runtime,
  replyBelow = true,
}: {
  runtime: "cloud" | "machine";
  replyBelow?: boolean;
}) {
  const store = useExternalStoreRuntime<ThreadMessageLike>({
    convertMessage: (message) => message,
    messages: [],
    onNew: done,
  });
  return (
    <TooltipProvider>
      <AssistantRuntimeProvider runtime={store}>
        <BottomBar
          atBottom
          canStop
          onLatest={noop}
          onReview={noop}
          onStop={noop}
          origin="ui"
          pending={null}
          replyBelow={replyBelow}
          requestVisible
          runNumber={3}
          state="working"
          stopping={false}
          typing={false}
        />
        <ComposerContainer busyNote={busyNote(runtime)} disabledNote={null} />
      </AssistantRuntimeProvider>
    </TooltipProvider>
  );
}

const render = async (props: Parameters<typeof WorkingThread>[0]) => {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as Element);
  await act(async () => {
    root.render(<WorkingThread {...props} />);
  });
  return { host, unmount: () => act(async () => root.unmount()) };
};

test("the reply box stays open while a Cloud task works, and says the agent reads it as it works", async () => {
  const { host, unmount } = await render({ runtime: "cloud" });
  const box = host.querySelector("textarea");
  expect(box).not.toBeNull();
  expect(box?.hasAttribute("disabled")).toBe(false);
  expect(host.textContent).toContain("Task 3 is working.");
  expect(host.textContent).not.toContain("Reply when it is done.");
  expect(host.querySelector('[data-testid="busy-note"]')?.textContent).toBe(
    "The agent reads this as it works."
  );
  expect(host.textContent).not.toContain("Sending starts task");
  await unmount();
});

test("another runtime's box says the agent gets the message when the step ends", async () => {
  const { host, unmount } = await render({ runtime: "machine" });
  expect(host.querySelector("textarea")).not.toBeNull();
  expect(host.querySelector('[data-testid="busy-note"]')?.textContent).toBe(
    "The agent gets this when the current step ends."
  );
  await unmount();
});

test("without a reply box under it, the working strip still tells the person to wait", async () => {
  const { host, unmount } = await render({
    replyBelow: false,
    runtime: "machine",
  });
  expect(host.textContent).toContain("Reply when it is done.");
  await unmount();
});

const threadMessage = (
  id: string,
  role: "user" | "assistant",
  runId: string,
  status: ThreadMessage["status"],
  assistantParts: ThreadMessage["parts"] = []
): ThreadMessage => ({
  createdAt: null,
  id,
  parts:
    role === "user" ? [{ text: `text ${id}`, type: "text" }] : assistantParts,
  role,
  runId,
  status,
});

function Thread({ messages }: { messages: readonly ThreadMessage[] }) {
  const activity = threadActivity([
    { runId: "r1", type: "run.queued" },
    { runId: "r1", type: "run.started" },
    { runId: "r2", type: "run.queued" },
  ]);
  const waiting = waitingMessages(messages, activity);
  const shown = withoutWaitingTurns(messages, waiting);
  const store = useExternalStoreRuntime<ThreadMessageLike>({
    convertMessage: (item) => item,
    messages: shown.map((item) => toThreadMessageLike(item)),
    onNew: () => Promise.resolve(),
  });
  return (
    <TooltipProvider>
      <AssistantRuntimeProvider runtime={store}>
        <ThreadEnvProvider
          value={{
            agentName: "Agent",
            answer: () => Promise.resolve(),
            editableId: null,
            edited: new Set(),
            files: new Map(),
            nowMs: null,
            removeWaiting: () => undefined,
            requests: new Map(),
            waiting,
          }}
        >
          <ThreadPrimitive.Root>
            <ThreadPrimitive.Messages
              components={{
                AssistantMessage: AssistantMessageContainer,
                UserMessage: UserMessageContainer,
              }}
            />
          </ThreadPrimitive.Root>
          <BottomBar
            atBottom
            canStop
            onLatest={noop}
            onReview={noop}
            onStop={noop}
            origin="ui"
            pending={null}
            replyBelow
            requestVisible
            runNumber={1}
            state="working"
            stopping={false}
            typing={false}
          />
        </ThreadEnvProvider>
      </AssistantRuntimeProvider>
    </TooltipProvider>
  );
}

test("a working run with a queued reply shows one Working indicator, and the reply shows only as waiting", async () => {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as Element);
  await act(async () => {
    root.render(
      <Thread
        messages={[
          threadMessage("u1", "user", "r1", "done"),
          threadMessage("a1", "assistant", "r1", "running"),
          threadMessage("u2", "user", "r2", "done"),
          threadMessage("a2", "assistant", "r2", "running"),
        ]}
      />
    );
  });
  const text = host.textContent ?? "";
  expect(text.split("Working")).toHaveLength(2);
  expect(host.querySelectorAll('[data-role="assistant"]')).toHaveLength(1);
  const [, queued] = host.querySelectorAll('[data-role="user"]');
  expect(queued?.textContent).toContain("Waiting for the current step to end");
  expect(
    queued?.querySelector('[data-testid="remove-waiting"]')
  ).not.toBeNull();
  expect(queued?.querySelector('[data-slot="spinner"]')).toBeNull();
  expect(host.textContent).toContain("Task 1 is working.");
  expect(host.querySelectorAll('[data-slot="spinner"]')).toHaveLength(1);
  await act(async () => root.unmount());
});

const renderSingleRun = async (message: ThreadMessage) => {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as Element);
  await act(async () => {
    root.render(
      <Thread messages={[threadMessage("u1", "user", "r1", "done"), message]} />
    );
  });
  return {
    host: host as unknown as Element,
    unmount: () => act(async () => root.unmount()),
  };
};

const toolCall = (ok: boolean | null): ThreadMessage["parts"] => [
  {
    input: { command: "ls" },
    name: "Bash",
    ok,
    result: ok === null ? null : "done",
    toolUseId: "t1",
    type: "tool-call",
  },
];

const spinners = (host: Element) =>
  host.querySelectorAll('[data-slot="spinner"]');

test("a running tool card is the one spinner, and the Working line leaves", async () => {
  const { host, unmount } = await renderSingleRun(
    threadMessage("a1", "assistant", "r1", "running", toolCall(null))
  );
  expect(spinners(host)).toHaveLength(1);
  expect(
    host.querySelector('[data-testid="tool-card"] [data-slot="spinner"]')
  ).not.toBeNull();
  expect(host.textContent).not.toContain("Working");
  await unmount();
});

test("with no tool card running, the turn's Working line is the one spinner", async () => {
  const { host, unmount } = await renderSingleRun(
    threadMessage("a1", "assistant", "r1", "running", toolCall(true))
  );
  expect(spinners(host)).toHaveLength(1);
  expect(host.textContent).toContain("Working");
  await unmount();
});

test("a waiting run with no request to answer still shows one Working spinner", async () => {
  const { host, unmount } = await renderSingleRun(
    threadMessage("a1", "assistant", "r1", "waiting")
  );
  expect(spinners(host)).toHaveLength(1);
  expect(host.textContent).not.toContain("Waiting for an answer");
  await unmount();
});
