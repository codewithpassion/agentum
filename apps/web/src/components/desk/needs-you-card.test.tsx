/** biome-ignore-all lint/suspicious/useAwait: Async act flushes effects and promises. */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
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
beforeAll(() => {
  for (const key of KEYS) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(dom, key),
    });
  }
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
    }),
  }));
});
afterAll(() => {
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
