/** biome-ignore-all lint/suspicious/useAwait: React act flushes queued updates. */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import type { ProposalInput } from "@repo/services/teams/proposal";
import { type HTMLButtonElement, Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { getTrpc as realGetTrpc } from "#/integrations/trpc/client";
import { ProposalCard } from "./request-card.tsx";
import type { AnswerPayload, RequestView } from "./request-card-logic.ts";

const dom = new Window();
const previous = new Map<string, PropertyDescriptor | undefined>();
const keys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Node",
  "IS_REACT_ACT_ENVIRONMENT",
];

const proposal: ProposalInput = {
  agentId: "agt_bo",
  agentName: "Writer Bo",
  field: "instructions",
  leadName: "Lead Ann",
  reason: "Drafts run long",
  value: "Write in short paragraphs.",
};
const view: Extract<RequestView, { kind: "approval" }> = {
  anchorId: null,
  display: {
    input: proposal,
    summary: "Lead Ann proposes changing Writer Bo's instructions",
    toolKey: "team_propose_change",
    toolName: "team_propose_change",
  },
  expiresAt: "2030-01-01T00:00:00Z",
  id: "req",
  kind: "approval",
  runId: "run",
  settled: null,
};

beforeAll(() => {
  for (const key of keys) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(dom, key),
    });
  }
  mock.module("#/integrations/trpc/client", () => ({
    getTrpc: () => ({
      agents: {
        get: {
          query: () =>
            Promise.resolve({
              instructions: "Write long, careful drafts.",
              model: "claude-sonnet-5-5",
              runtimeConfig: {},
            }),
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

const buttons = (container: {
  querySelectorAll: (selector: string) => Iterable<unknown>;
}): HTMLButtonElement[] =>
  Array.from(container.querySelectorAll("button")) as HTMLButtonElement[];

test("the card names the lead and the member, shows old and new value, and offers Approve and Reject only", async () => {
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container as unknown as Element);
  const answers: AnswerPayload[] = [];
  const answer = (_view: RequestView, payload: AnswerPayload) => {
    answers.push(payload);
    return Promise.resolve();
  };
  await act(async () =>
    root.render(
      <ProposalCard
        nowMs={0}
        onAnswer={answer}
        proposal={proposal}
        view={view}
      />
    )
  );
  const text = container.textContent ?? "";
  expect(container.querySelector("h3")?.textContent).toBe(
    "Lead Ann proposes a change to Writer Bo"
  );
  expect(text).toContain("Instructions");
  expect(text).toContain("Write long, careful drafts.");
  expect(text).toContain("Write in short paragraphs.");
  expect(text).toContain("Drafts run long");
  const labels = buttons(container).map((button) => button.textContent);
  expect(labels).toEqual(["Approve", "Reject"]);
  expect(text).not.toContain("Always allow");

  await act(async () => buttons(container)[0]?.click());
  await act(async () => buttons(container)[1]?.click());
  expect(answers).toEqual([{ decision: "allow_once" }, { decision: "deny" }]);
  await act(async () => root.unmount());
});
