/** biome-ignore-all lint/performance/noJsxPropsBind: Interaction harness captures form state. */
/** biome-ignore-all lint/suspicious/useAwait: Async act flushes effects. */
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import type { ThreadMessageLike } from "@assistant-ui/react";
import type { AgentDraft } from "@repo/services/agent-builder/draft";
import { Window } from "happy-dom";
import { act, type ReactNode, useEffect, useState } from "react";
// biome-ignore lint/performance/noNamespaceImport: spyOn needs the module object.
import * as desktop from "#/components/computer/use-desktop-screen";
// biome-ignore lint/performance/noNamespaceImport: spyOn needs the module object.
import * as capture from "#/components/dictation/capture";
// biome-ignore lint/performance/noNamespaceImport: spyOn needs the module object.
import * as dialog from "#/components/ui/dialog";
import { dictationAdapter } from "./dictation-adapter";

const noop = () => undefined;
const done = () => Promise.resolve();
const dom = new Window({ url: "http://localhost" });
const previous = new Map<string, PropertyDescriptor | undefined>();

const spies: { mockRestore: () => void }[] = [];
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
const {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} = await import("@tanstack/react-router");
const { createRoot } = await import("react-dom/client");
const router = createRouter({
  history: createMemoryHistory({ initialEntries: ["/"] }),
  routeTree: createRootRoute(),
});
const { AgentForm } = await import("#/components/agent/agent-form");
const { DescribePanel } = await import(
  "#/components/agent/builder/describe-panel"
);
const { DraftCard } = await import("#/components/agent/builder/draft-card");
const { VoiceField } = await import("#/components/agent/profile/voice-field");
const { DesktopScreen } = await import("#/components/computer/desktop-screen");
const { PostComposer } = await import("#/components/inbox/post-composer");
const { AgentComposer } = await import(
  "#/components/live-artifacts/agent-thread"
);
const { AnswerForm } = await import("#/components/qa/answer-form");
const { AskDialog } = await import("#/components/qa/ask-dialog");
const { CreateRoutineDialog } = await import(
  "#/components/routines/create-routine-dialog"
);
const { UserEditComposerContainer } = await import(
  "#/components/thread/user-edit-composer-container"
);
const { TooltipProvider } = await import("#/components/ui/tooltip");
beforeAll(() => {
  Object.defineProperty(dom, "visualViewport", {
    configurable: true,
    value: null,
  });
  spies.push(
    // Keep portal/focus management out of this wiring test: Radix caches whether
    // a DOM exists at import time, which varies with the other selected tests.
    spyOn(dialog, "DialogContent").mockImplementation(({ children }) => (
      <div>{children}</div>
    )),
    spyOn(dictationAdapter, "status").mockResolvedValue({ available: true }),
    spyOn(dictationAdapter, "transcribe").mockResolvedValue({
      text: "dictated words",
    }),
    spyOn(dictationAdapter, "polish").mockResolvedValue({
      text: "Dictated words.",
    }),
    spyOn(capture, "startCapture").mockImplementation(async (samples) => {
      samples(new Float32Array(1600).fill(0.2));
      return { devices: [], stop: noop };
    }),
    spyOn(desktop, "useDesktopScreen").mockReturnValue({
      canvasRef: { current: null },
      connection: "open",
      flushInput: noop,
      hasFrame: true,
      inputError: null,
      problem: null,
      sendInput: noop,
      status: { youHaveControl: true } as desktop.DesktopScreen["status"],
    })
  );
});
afterAll(() => {
  for (const spy of spies) {
    spy.mockRestore();
  }
  for (const [key, value] of previous) {
    if (value) {
      Object.defineProperty(globalThis, key, value);
    } else {
      Reflect.deleteProperty(globalThis, key);
    }
  }
});
function Description() {
  const [dictating, setDictating] = useState(false);
  const [description, setDescription] = useState("");
  return (
    <>
      {" "}
      <output data-testid="dictating">{String(dictating)}</output>
      <DescribePanel
        busy={false}
        description={description}
        error={null}
        hasDraft={false}
        onDescription={setDescription}
        onDictationBusyChange={setDictating}
        onDraft={noop}
        onTemplate={noop}
        onVoice={noop}
        steps={[]}
        voice={undefined}
      />
    </>
  );
}
function Draft() {
  const [dictating, setDictating] = useState(false);
  const [draft, setDraft] = useState<AgentDraft>({
    does: "",
    handsTo: [],
    library: [],
    name: "Agent",
    rules: [],
    runsOn: null,
    sampleInput: [],
    skills: [],
    startsOn: [],
    tools: [],
    voice: "brief",
  });
  return (
    <>
      {" "}
      <output data-testid="dictating">{String(dictating)}</output>
      <output data-testid="saved-rules">{draft.rules.join("\n")}</output>
      <DraftCard
        address=""
        catalog={{
          agents: [],
          connectors: [],
          machines: [],
          runtimes: [],
          skills: [],
        }}
        draft={draft}
        gaps={[]}
        locked={{}}
        onAddress={noop}
        onDictationBusyChange={setDictating}
        onEdit={(patch) => setDraft((old) => ({ ...old, ...patch }))}
      />
    </>
  );
}
const HiddenMessage = () => null;
function Edit() {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    convertMessage: (message) => message,
    messages: [
      {
        content: [{ text: "original", type: "text" }],
        id: "message",
        metadata: { custom: {} },
        role: "user",
      },
    ],
    onEdit: done,
    onNew: done,
  });
  useEffect(() => {
    runtime.thread.getMessageByIndex(0).composer.beginEdit();
  }, [runtime]);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Messages
        components={{
          AssistantMessage: HiddenMessage,
          UserMessage: UserEditComposerContainer,
        }}
      />
    </AssistantRuntimeProvider>
  );
}
const cases: {
  name: string;
  node: ReactNode;
  selector: string;
  open?: string;
  index?: number;
}[] = [
  {
    name: "artifact and deck chat",
    node: <AgentComposer artifactId="artifact" canAsk onSent={done} />,
    selector: "textarea",
  },
  { name: "edit message", node: <Edit />, selector: "textarea" },
  {
    name: "routine prompt",
    node: (
      <CreateRoutineDialog agentId="agent" onClose={noop} onCreated={noop} />
    ),
    selector: "textarea",
  },
  {
    name: "agent instructions",
    node: (
      <AgentForm
        initial={{
          environment: "isolate",
          instructions: "",
          machineId: "",
          maxTurns: "",
          model: "sonnet",
          name: "Agent",
          networkAccess: true,
          runtime: "managed",
        }}
        machines={[]}
        onSubmit={done}
        providerKeys={{ openrouter: true }}
        submitLabel="Save"
      />
    ),
    selector: "textarea",
  },
  { name: "builder description", node: <Description />, selector: "textarea" },
  {
    name: "draft does",
    node: <Draft />,
    selector: 'textarea[aria-label="Does"]',
  },
  {
    index: 1,
    name: "draft rules",
    node: <Draft />,
    selector: 'textarea[aria-label="Rules"]',
  },
  {
    name: "agent voice",
    node: <VoiceField agentId="agent" voice="" />,
    selector: "textarea",
  },
  {
    name: "question details",
    node: <AskDialog onAsked={noop} />,
    open: "Ask a question",
    selector: "textarea",
  },
  {
    name: "answer",
    node: <AnswerForm onAnswered={noop} questionId="question" />,
    selector: "textarea",
  },
  {
    name: "inbox message",
    node: <PostComposer onSent={noop} threadId="thread" />,
    selector: "textarea",
  },
  {
    name: "handback note",
    node: <DesktopScreen machineId="machine" takeover={null} />,
    selector: 'textarea[placeholder="Logged in as accounts@…"]',
  },
];
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
test.each(cases)(
  "$name renders a mic and inserts dictated text at the selection",
  async ({ name, node, selector, open, index = 0 }) => {
    const host = dom.document.createElement("div");
    dom.document.body.append(host);
    const root = createRoot(host as unknown as Element);
    try {
      await act(async () => {
        root.render(
          <RouterContextProvider router={router}>
            <TooltipProvider>{node}</TooltipProvider>
          </RouterContextProvider>
        );
      });
      if (open) {
        const button = [...dom.document.querySelectorAll("button")].find(
          (item) => item.textContent?.includes(open)
        );
        expect(button).toBeDefined();
        await act(async () => {
          button?.click();
        });
      }
      await settle();
      const input = dom.document.querySelector(selector);
      expect(input).not.toBeNull();
      const textarea = input as unknown as HTMLTextAreaElement;
      const base = textarea.value;
      textarea.focus();
      textarea.setSelectionRange(0, base.length);
      const mic = dom.document.querySelectorAll<
        import("happy-dom").HTMLButtonElement
      >('button[aria-label="Start dictation"]')[index];
      expect(mic).toBeDefined();
      expect(mic?.hasAttribute("disabled")).toBe(false);
      await act(async () => {
        mic?.click();
      });
      await settle();
      expect(textarea.readOnly).toBe(true);
      const dictating = dom.document.querySelector('[data-testid="dictating"]');
      if (dictating) {
        expect(dictating.textContent).toBe("true");
      }
      await act(async () => {
        dom.document
          .querySelector<import("happy-dom").HTMLButtonElement>(
            'button[aria-label="Stop dictation"]'
          )
          ?.click();
      });
      await settle();
      expect(textarea.value).toBe("Dictated words.");
      expect(textarea.readOnly).toBe(false);
      const submitLabels: Record<string, string> = {
        "agent instructions": "Save",
        "agent voice": "Save",
        answer: "Post answer",
        "artifact and deck chat": "Send to agent",
        "builder description": "Draft",
        "edit message": "Edit and resend",
        "handback note": "Hand back",
        "inbox message": "Send",
      };
      const submitLabel = submitLabels[name];
      if (submitLabel) {
        const submit = [...dom.document.querySelectorAll("button")].find(
          (button) => button.textContent?.trim().startsWith(submitLabel)
        );
        expect(submit?.disabled).toBe(false);
        await act(async () => {
          mic?.click();
        });
        await settle();
        expect(submit?.disabled).toBe(true);
        await act(async () => {
          dom.window.dispatchEvent(
            new dom.KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
          );
        });
        await settle();
        expect(textarea.value).toBe("Dictated words.");
        expect(submit?.disabled).toBe(false);
      }
      if (dictating) {
        expect(dictating.textContent).toBe("false");
      }
      if (selector.includes("Rules")) {
        expect(
          dom.document.querySelector('[data-testid="saved-rules"]')?.textContent
        ).toBe("Dictated words.");
        // Blurring after dictation keeps the committed rules.
        await act(async () => {
          textarea.blur();
        });
      }
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  }
);
