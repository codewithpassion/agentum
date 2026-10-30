import { expect, test } from "bun:test";
import type { RailCard } from "@repo/db/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { MailDecision } from "./mail-decision.tsx";

const card: RailCard = {
  agentId: "agent_1",
  agentName: "Sam",
  at: "2026-10-31T01:00:00.000Z",
  detail: "Can we meet Thursday?",
  expiresAt: null,
  id: "req_1",
  kind: "approval",
  mail: {
    body: "Hi Priya,\n\nThursday works.",
    subject: "Team page",
    theyWrote: "Can we meet Thursday?",
    to: ["priya@example.com"],
  },
  passedOnBy: null,
  runId: "run_1",
  status: "Reply ready",
  threadId: "thr_1",
  title: "Reply to Priya: Team page",
};

const noop = () => Promise.resolve();

const render = (props: {
  cc?: string[];
  expiry?: string | null;
  waitingOn?: string | null;
}) =>
  renderToStaticMarkup(
    <MailDecision
      card={card}
      cc={props.cc ?? []}
      expiry={props.expiry ?? null}
      onAnswer={noop}
      waitingOn={props.waitingOn ?? null}
    />
  );

test("shows what they wrote, the reply in body type and who it goes to", () => {
  const html = render({});
  expect(html).toContain("They wrote");
  expect(html).toContain("Can we meet Thursday?");
  expect(html).toContain("Thursday works.");
  expect(html).toContain("Goes to priya@example.com");
  expect(html).not.toContain("<pre");
  expect(html).not.toContain("font-mono");
  expect(html).not.toContain("Use mail_send");
});

test("offers the three answers by their plain names", () => {
  const html = render({});
  expect(html).toContain(">Send reply</button>");
  expect(html).toContain(">Not this time</button>");
  expect(html).toContain(">Always send to this address</button>");
  expect(html).toContain(">Tell it what to change</button>");
});

test("names who it waits on and shows the expiry only when given one", () => {
  expect(render({})).not.toContain("Waiting on");
  expect(render({ waitingOn: "Priya" })).toContain("Waiting on Priya");
  expect(render({ expiry: "expires in 42 min" })).toContain(
    "expires in 42 min"
  );
  expect(render({})).not.toContain("expires");
});

test("names the Cc recipients, who get the reply too", () => {
  expect(render({})).not.toContain("Cc");
  expect(render({ cc: ["boss@example.com", "hr@example.com"] })).toContain(
    "Cc boss@example.com, hr@example.com"
  );
});
