import { expect, test } from "bun:test";
import type { DeskCard } from "@repo/db/shared";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { NeedsYouBody, ThreadBody } from "./needs-you-card.tsx";

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
              { id: "g2", kind: "agent", target: "agent_1" },
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
  expect(html).toContain("Hand off to agent agent_1");
  expect(html).toContain(">Approve</button>");
  expect(html).toContain(">Reject</button>");
});
