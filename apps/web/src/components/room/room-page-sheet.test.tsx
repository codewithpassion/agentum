/** biome-ignore-all lint/suspicious/useAwait: Async act flushes effects and promises. */
import { afterAll, expect, mock, test } from "bun:test";
import type { Team } from "@repo/db/shared";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { Window } from "happy-dom";
import {
  act,
  cloneElement,
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
} from "react";
import { createRoot } from "react-dom/client";
import { getTrpc as realGetTrpc } from "#/integrations/trpc/client";
import type { InboxThread } from "#/integrations/trpc/types";

const dom = new Window({ url: "https://preview.agentum.test" });
const previous = new Map<string, PropertyDescriptor | undefined>();
const keys = [
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
  "NodeFilter",
  "DocumentFragment",
  "Element",
  "FocusEvent",
  "PointerEvent",
  "IS_REACT_ACT_ENVIRONMENT",
];

const created = { id: "t_new", teamId: "team_1", title: "Budget" };
const createThread = mock((_input: unknown) => Promise.resolve(created));
const listThreads = mock((_input: unknown) => Promise.resolve([]));
const slackStatus = mock((_input: unknown) => Promise.resolve(null));

// Radix picks its layout effect when it first loads, and a test file that ran
// earlier may have loaded it without a DOM, so its portals never mount. The
// sheet and dialog are plain stand-ins that keep the open and onOpenChange
// contract.
interface OpenState {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}
const OpenContext = createContext<OpenState>({
  onOpenChange: () => undefined,
  open: false,
});
const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
const Root = ({
  children,
  onOpenChange,
  open,
}: OpenState & { children: ReactNode }) => (
  <OpenContext.Provider value={{ onOpenChange, open }}>
    {children}
  </OpenContext.Provider>
);
const Trigger = ({
  children,
}: {
  children: ReactElement<{ onClick?: () => void }>;
}) => {
  const { onOpenChange } = useContext(OpenContext);
  return cloneElement(children, { onClick: () => onOpenChange(true) });
};
const makeContent = (slot: string, role: string) =>
  function Content({ children }: { children: ReactNode }) {
    const { open } = useContext(OpenContext);
    return open ? (
      <div data-slot={slot} role={role}>
        {children}
      </div>
    ) : null;
  };
const realSheet = await import("#/components/ui/sheet.tsx");
const realDialog = await import("#/components/ui/dialog.tsx");
mock.module("#/components/ui/sheet.tsx", () => ({
  ...realSheet,
  Sheet: Root,
  SheetContent: makeContent("sheet-content", "dialog"),
  SheetDescription: Pass,
  SheetHeader: Pass,
  SheetTitle: Pass,
  SheetTrigger: Trigger,
}));
mock.module("#/components/ui/dialog.tsx", () => ({
  ...realDialog,
  Dialog: Root,
  DialogContent: makeContent("dialog-content", "dialog"),
  DialogHeader: Pass,
  DialogTitle: Pass,
  DialogTrigger: Trigger,
}));

for (const key of keys) {
  previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(dom, key),
  });
}
mock.module("#/integrations/trpc/client", () => ({
  getTrpc: () => ({
    inbox: {
      createThread: { mutate: createThread },
      listThreads: { query: listThreads },
    },
    teams: { slack: { status: { query: slackStatus } } },
  }),
}));

const { RoomPage } = await import("./room-page.tsx");

afterAll(() => {
  mock.module("#/components/ui/sheet.tsx", () => realSheet);
  mock.module("#/components/ui/dialog.tsx", () => realDialog);
  mock.module("#/integrations/trpc/client", () => ({ getTrpc: realGetTrpc }));
  for (const [key, descriptor] of previous) {
    if (descriptor) {
      Object.defineProperty(globalThis, key, descriptor);
    } else {
      Reflect.deleteProperty(globalThis, key);
    }
  }
});

const router = createRouter({
  history: createMemoryHistory({ initialEntries: ["/"] }),
  routeTree: createRootRoute(),
});

const team = {
  archivedAt: null,
  id: "team_1",
  members: [
    {
      isHome: false,
      memberId: "u_amir",
      memberKind: "user",
      teamId: "team_1",
    },
  ],
  name: "Finance",
  slug: "finance",
} as Team;

const SHEET = '[data-slot="sheet-content"]';

interface Clickable {
  click: () => void;
  textContent: string | null;
}

const buttonIn = (
  root: { querySelectorAll: (selector: string) => Iterable<unknown> },
  label: string
): Clickable => {
  const button = ([...root.querySelectorAll("button")] as Clickable[]).find(
    (candidate) => candidate.textContent?.trim() === label
  );
  if (button === undefined) {
    throw new Error(`no ${label} button`);
  }
  return button;
};

const setValue = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(
    dom.HTMLInputElement.prototype,
    "value"
  )?.set;
  // React reads a dispatched input only after a keyup on the focused field here.
  input.focus();
  setter?.call(input, value);
  input.dispatchEvent(
    new dom.KeyboardEvent("keyup", { bubbles: true }) as unknown as Event
  );
  input.dispatchEvent(
    new dom.Event("input", { bubbles: true }) as unknown as Event
  );
};

test("the topics sheet closes when New topic creates a topic", async () => {
  const opened: string[] = [];
  const onOpenTopic = (id: string) => {
    opened.push(id);
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () =>
    root.render(
      <RouterContextProvider router={router}>
        <RoomPage
          agents={[]}
          handles={new Map()}
          onOpenTopic={onOpenTopic}
          people={[]}
          team={team}
          threads={[] as InboxThread[]}
          topicId={undefined}
          userId="u_amir"
        />
      </RouterContextProvider>
    )
  );
  try {
    await act(async () => buttonIn(container, "Topics").click());
    const sheet = document.querySelector(SHEET);
    expect(sheet).not.toBeNull();

    await act(async () =>
      buttonIn(
        document.querySelector(SHEET) as unknown as HTMLElement,
        "New topic"
      ).click()
    );
    const dialog = document.querySelector(
      '[role="dialog"][data-slot="dialog-content"]'
    );
    const title = dialog?.querySelector("input");
    expect(title).not.toBeNull();
    await act(async () => setValue(title as HTMLInputElement, "Budget"));
    const create = buttonIn(dialog as unknown as HTMLElement, "Create topic");
    await act(async () => create.click());

    expect(createThread).toHaveBeenCalledTimes(1);
    expect(opened).toEqual(["t_new"]);
    expect(document.querySelector(SHEET)).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
