/** biome-ignore-all lint/suspicious/useAwait: Async act flushes effects and promises. */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { useUser as realUseUser } from "@clerk/tanstack-react-start";
import type { DeskCard } from "@repo/db/shared";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { getTrpc as realGetTrpc } from "#/integrations/trpc/client";
import {
  NeedsYouBody,
  NeedsYouCard,
  PersonAppGrants,
  ThreadBody,
} from "./needs-you-card.tsx";

const router = createRouter({
  history: createMemoryHistory({ initialEntries: ["/"] }),
  routeTree: createRootRoute(),
});

const thread: DeskCard = {
  agentId: "agent_1",
  at: "2026-10-31T01:00:00.000Z",
  band: { text: "Waiting on a reply", tone: "waiting" },
  id: "thread_1",
  kind: "thread",
  lane: "needs_you",
  needsYouKind: "inbox_reply",
  startedBy: "agent_1",
  threadId: "thread_1",
  title: "Reply to Acme",
};

const noop = () => undefined;
const answer = () => Promise.resolve();

const render = () =>
  renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <ThreadBody card={thread} onChanged={noop} />
    </RouterContextProvider>
  );

test("a thread card links to the thread and offers Dismiss", () => {
  const html = render();
  expect(html).toContain("Open thread");
  expect(html).toContain(">Dismiss</button>");
});

test("a spend pause card names the agent and offers Resume", () => {
  const html = renderToStaticMarkup(
    <NeedsYouCard
      agentName="Builder"
      card={{ ...thread, kind: "request", needsYouKind: "spend_pause" }}
      nowMs={0}
      onAnswer={answer}
      onChanged={noop}
      request={null}
      version={null}
    />
  );
  expect(html).toContain("Builder stopped at its weekly limit");
  expect(html).toContain(">Resume</button>");
});

test("Needs you renders grant approval for endpoint and agent requests", () => {
  const html = renderToStaticMarkup(
    <NeedsYouBody
      agentName="Builder"
      card={{ ...thread, kind: "request", needsYouKind: "approval" }}
      nowMs={Date.parse("2026-11-04T00:00:00Z")}
      onAnswer={answer}
      onChanged={noop}
      request={{
        anchorId: null,
        display: {
          input: {
            artifactId: "a1",
            grants: [
              { id: "g1", kind: "endpoint", target: "discord" },
              {
                id: "g2",
                kind: "agent",
                name: "Support bot",
                target: "agent_1",
              },
            ],
            title: "Bot",
            version: 1,
            versionId: "v1",
          },
          summary: "Promote Bot",
          toolKey: "harbourmaster/artifact_promote",
          toolName: "artifact_promote",
        },
        expiresAt: "2026-11-04T01:00:00Z",
        id: "request_1",
        kind: "approval",
        runId: "run_1",
        settled: null,
      }}
      version={null}
    />
  );
  expect(html).toContain("Bot v1 asks for access");
  expect(html).toContain("Public address: discord");
  expect(html).toContain("Hand off to agent Support bot");
  expect(html).toContain(">Approve</button>");
  expect(html).toContain(">Reject</button>");
});

test("Needs you renders a decision queue as a card with its progress and Dismiss", () => {
  const html = renderToStaticMarkup(
    <NeedsYouBody
      agentName="Builder"
      card={{ ...thread, kind: "request", needsYouKind: "decisions" }}
      nowMs={Date.parse("2026-11-04T00:00:00Z")}
      onAnswer={answer}
      onChanged={noop}
      request={{
        anchorId: null,
        display: {
          questions: [
            { id: "q1", options: ["Red", "Blue"], text: "Which colour?" },
            { id: "q2", options: ["Now", "Later"], text: "When?" },
          ],
        },
        expiresAt: "2026-11-04T01:00:00Z",
        given: { q1: "Red" },
        id: "request_1",
        kind: "decisions",
        runId: "run_1",
        settled: null,
      }}
      version={null}
    />
  );
  expect(html).toContain("1 of 2 answered");
  expect(html).toContain("Which colour?");
  expect(html).toContain(">Send answers</button>");
  expect(html).toContain(">Dismiss</button>");
});

const dom = new Window({ url: "http://localhost/" });
const previous = new Map<string, PropertyDescriptor | undefined>();
const KEYS = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Node",
  "IS_REACT_ACT_ENVIRONMENT",
];
const decisions: unknown[] = [];
const grantQueries: unknown[] = [];
const memoryDecisions: unknown[] = [];
beforeAll(() => {
  for (const key of KEYS) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(dom, key),
    });
  }
  mock.module("@clerk/tanstack-react-start", () => ({
    useUser: () => ({ user: null }),
  }));
  mock.module("#/integrations/trpc/client", () => ({
    getTrpc: () => ({
      agents: {
        list: {
          query: () =>
            Promise.resolve([{ id: "agent_1", name: "Support bot" }]),
        },
      },
      artifacts: {
        decideGrant: {
          mutate: (input: unknown) => {
            decisions.push(input);
            return Promise.resolve({});
          },
        },
        get: {
          query: () =>
            Promise.resolve({
              currentVersion: { id: "v3", number: 3 },
              title: "Bot",
            }),
        },
        grants: {
          query: (input: unknown) => {
            grantQueries.push(input);
            return Promise.resolve([
              {
                id: "g1",
                kind: "endpoint",
                status: "pending",
                target: "discord",
              },
              { id: "g2", kind: "agent", status: "pending", target: "agent_1" },
              {
                id: "g3",
                kind: "host",
                status: "approved",
                target: "discord.com",
              },
            ]);
          },
        },
        versions: {
          query: () =>
            Promise.resolve([
              { id: "v2", number: 2 },
              { id: "v3", number: 3 },
            ]),
        },
      },
      memory: {
        decide: {
          mutate: (input: unknown) => {
            memoryDecisions.push(input);
            return Promise.resolve({});
          },
        },
      },
    }),
  }));
});
afterAll(() => {
  mock.module("@clerk/tanstack-react-start", () => ({ useUser: realUseUser }));
  mock.module("#/integrations/trpc/client", () => ({ getTrpc: realGetTrpc }));
  for (const [key, descriptor] of previous) {
    if (descriptor) {
      Object.defineProperty(globalThis, key, descriptor);
    } else {
      Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("person grant card reviews its own version, links the app and decides pending grants", async () => {
  const container = document.createElement("div");
  const root = createRoot(container as unknown as Element);
  let changed = 0;
  const onChanged = () => {
    changed += 1;
  };
  try {
    await act(async () =>
      root.render(
        <PersonAppGrants
          card={{
            ...thread,
            artifactId: "app1",
            id: "v2",
            needsYouKind: "artifact_grant",
          }}
          nowMs={0}
          onChanged={onChanged}
        />
      )
    );
    expect(grantQueries).toEqual([{ artifactId: "app1", versionId: "v2" }]);
    expect(container.textContent).toContain("Bot v2 asks for access");
    expect(container.textContent).not.toContain("Bot v3");
    expect(container.textContent).toContain("Hand off to agent Support bot");
    expect(container.textContent).not.toContain("discord.com");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/a/app1");
    expect(container.querySelector("a")?.textContent).toBe("See app");
    expect(
      [...container.querySelectorAll("p")].every((p) => p.textContent !== "")
    ).toBe(true);
    await act(async () => container.querySelector("button")?.click());
    expect(decisions).toEqual([
      { decision: "approved", grantId: "g1" },
      { decision: "approved", grantId: "g2" },
    ]);
    expect(changed).toBe(1);
  } finally {
    await act(async () => root.unmount());
  }
});

/** Renders a held memory note's body, clicks the button with `label`, and returns what the page did. */
const decideHeldNote = async (label: "Approve" | "Reject") => {
  const container = document.createElement("div");
  const root = createRoot(container as unknown as Element);
  let changed = 0;
  const onChanged = () => {
    changed += 1;
  };
  try {
    await act(async () =>
      root.render(
        <NeedsYouBody
          agentName="Builder"
          card={{
            ...thread,
            band: { text: "The office is in Fremantle", tone: "waiting" },
            id: "change_1",
            kind: "proposal",
            needsYouKind: "memory_note",
            title: "Builder wants to remember something",
          }}
          nowMs={0}
          onAnswer={answer}
          onChanged={onChanged}
          request={null}
          version={null}
        />
      )
    );
    const buttons = [...container.querySelectorAll("button")];
    await act(async () =>
      buttons.find((button) => button.textContent === label)?.click()
    );
    return {
      buttons: buttons.map((button) => button.textContent),
      changed,
      text: container.textContent,
    };
  } finally {
    await act(async () => root.unmount());
  }
};

test("a held memory note shows its text, and Approve decides that change", async () => {
  memoryDecisions.length = 0;
  const page = await decideHeldNote("Approve");

  expect(page.text).toContain("The office is in Fremantle");
  expect(page.buttons).toEqual(["Approve", "Reject"]);
  expect(memoryDecisions).toEqual([
    { changeId: "change_1", decision: "approve" },
  ]);
  expect(page.changed).toBe(1);
});

test("Reject on a held memory note rejects that change", async () => {
  memoryDecisions.length = 0;
  const page = await decideHeldNote("Reject");

  expect(memoryDecisions).toEqual([
    { changeId: "change_1", decision: "reject" },
  ]);
  expect(page.changed).toBe(1);
});
