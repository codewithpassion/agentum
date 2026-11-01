#!/usr/bin/env bun
// Two Harbourmaster deployments on one machine, talking over real HTTP. Each
// is its own `vite dev` Worker with its own `.wrangler` state, so there are
// two databases, two Durable Object sets and a real request between them (a
// deployment never calls its own origin, and a request to the other one is not
// dispatched in-process). Dev builds let a peer live on localhost over plain
// http; a production build refuses both (a test covers it).
//
// Every step a person takes goes through the real tRPC routes, signed in as
// the dev user of the Clerk dev instance, once per deployment. The steps:
//
//   1. Pairing: A makes an invite, B joins with the link, both sides show the
//      same check code, A approves, A's outbox delivers the activation to B,
//      and both rows are active.
//   2. A messages B. B holds the message for approval (the default), a person
//      on B approves it, B's agent answers, and A reads the answer. A's run had
//      ended by then, so the answer is a wake: a follow-up run in A's session.
//   3. B messages A through the outbound approval card (the default), A takes
//      the message without approval, and the answer wakes B's agent the same way.
//   4. Revoke on A. A's key stops working at once (B's next message is
//      refused before A's notice reaches B), then A's outbox delivers the
//      notice and B's row shows revoked. A's side refuses to send as well.
//
// Run from the repo root:  bun scripts/e2e/a2a-two-deployments.ts [--work-dir <dir>]
// Exit code 0 when every check passed. The summary goes into
// docs/reviews/tasks/AA.8.md.
import { mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  createDeployment,
  type Deployment,
  defaultWorkDir,
  E2eError,
  freePort,
  type PublishedAgent,
  publishAgent,
  queryRows,
  sleep,
  waitUntil,
} from "./a2a-harness.ts";

// ---------------------------------------------------------------------------
// Checks, as in a2a-interop.ts

interface Result {
  detail: string;
  name: string;
  ok: boolean;
}
const results: Result[] = [];

const check = async (
  name: string,
  body: () => Promise<string | undefined>
): Promise<boolean> => {
  const started = Date.now();
  try {
    const detail = (await body()) ?? "";
    results.push({ detail, name, ok: true });
    console.log(
      `ok    ${name}${detail ? ` (${detail})` : ""} ${Date.now() - started} ms`
    );
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ detail, name, ok: false });
    console.log(`FAIL  ${name}: ${detail}`);
    return false;
  }
};

const expect = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new E2eError(message);
  }
};

// ---------------------------------------------------------------------------
// What a person sees

interface Connection {
  agentId: string;
  checkCode: string | null;
  id: string;
  inboundPolicy: string;
  outboundPolicy: string;
  peerLabel: string | null;
  peerOrigin: string | null;
  slug: string;
  status: string;
}

interface RunView {
  error: string | null;
  resultText: string | null;
  status: string;
}

interface PendingRequest {
  id: string;
}

const WAITING_WORDS = /waiting|approve|pending/i;

const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");

const connectionsOf = (
  deployment: Deployment,
  agentId: string
): Promise<Connection[]> =>
  deployment.person.query<Connection[]>("a2a.list", { agentId });

const startRun = async (
  deployment: Deployment,
  agentId: string,
  text: string,
  sessionKey: string
): Promise<string> =>
  (
    await deployment.person.mutate<{ runId: string }>("runs.start", {
      agentId,
      input: { text },
      session: { externalKey: sessionKey, origin: "ui" },
    })
  ).runId;

const waitForRun = async (
  deployment: Deployment,
  runId: string
): Promise<RunView> => {
  let view: RunView = { error: null, resultText: null, status: "queued" };
  await waitUntil("the run ending", 120_000, async () => {
    view = await deployment.person.query<RunView>("runs.get", { runId });
    return ["done", "failed", "cancelled", "interrupted"].includes(view.status);
  });
  return view;
};

const sendTool = (slug: string, text: string, waitMs = 0): string =>
  `call harbourmaster_send_message ${JSON.stringify({ agent: slug, text, waitMs })}`;

/** Runs the minute tick on both deployments every two seconds until `done` is true. */
const tickBoth = (
  label: string,
  deployments: Deployment[],
  done: () => boolean,
  timeoutMs = 90_000
): Promise<void> =>
  waitUntil(
    label,
    timeoutMs,
    async () => {
      for (const deployment of deployments) {
        // biome-ignore lint/performance/noAwaitInLoops: The two ticks run one after the other.
        await deployment.tick();
      }
      return done();
    },
    2000
  );

interface RunRow {
  input_text: string;
  result_text: string | null;
  status: string;
}

/** The runs of an agent, oldest first. */
const runsOf = (deployment: Deployment, agentId: string): RunRow[] =>
  queryRows<RunRow>(
    deployment,
    "select input_text, result_text, status from runs where agent_id = ? order by created_at, id",
    agentId
  );

/**
 * Whether one of the runs is a wake that carries `answer`: a finished run whose
 * input is a peer's turn envelope holding the text. The run that sent the
 * message names the text too, in its tool call, so only the envelope counts.
 */
const wokenBy = (rows: RunRow[], answer: string): boolean =>
  rows.some(
    (row) =>
      row.status === "done" &&
      row.input_text.startsWith('{"harbourmaster_turn"') &&
      row.input_text.includes('"kind":"peer"') &&
      row.input_text.includes(answer)
  );

// ---------------------------------------------------------------------------

const scenario = async (a: Deployment, b: Deployment): Promise<void> => {
  const alice: PublishedAgent = await publishAgent(a.person, "Alice Support");
  const bob: PublishedAgent = await publishAgent(b.person, "Bob Helper");
  let aliceSide: Connection | undefined;
  let bobSide: Connection | undefined;

  // 1. Pairing
  await check(
    "pairing: A invites, B joins over HTTP, both show one check code",
    async () => {
      const invite = await a.person.mutate<{ link: string }>(
        "a2a.createInvite",
        {
          agentId: alice.agentId,
        }
      );
      expect(
        invite.link.startsWith(`${a.origin}/connect/`),
        `the invite link is ${invite.link}`
      );
      const joined = await b.person.mutate<{
        checkCode: string;
        connection: Connection;
      }>("a2a.joinWithLink", { agentId: bob.agentId, link: invite.link });
      expect(
        joined.connection.status === "awaiting_peer",
        `B is ${joined.connection.status}`
      );
      [aliceSide] = (await connectionsOf(a, alice.agentId)).filter(
        (connection) => connection.status === "needs_approval"
      );
      expect(aliceSide, "A shows no connection that needs approval");
      expect(
        aliceSide?.checkCode === joined.checkCode,
        `check codes differ: A ${aliceSide?.checkCode}, B ${joined.checkCode}`
      );
      bobSide = joined.connection;
      return `code ${joined.checkCode}, B's origin ${aliceSide?.peerOrigin}`;
    }
  );
  if (!(aliceSide && bobSide)) {
    return;
  }
  const fromA = aliceSide;
  const fromB = bobSide;

  await check(
    "pairing: A approves, the activation reaches B, both rows are active",
    async () => {
      const approved = await a.person.mutate<Connection>("a2a.approve", {
        connectionId: fromA.id,
        seen: { origin: fromA.peerOrigin, tokenUrl: null },
      });
      expect(
        ["activating", "active"].includes(approved.status),
        `A is ${approved.status} after approving`
      );
      // The activation goes out through A's outbox, which the tick delivers.
      await waitUntil(
        "both rows to be active",
        60_000,
        async () => {
          await a.tick();
          const mine = (await connectionsOf(a, alice.agentId)).find(
            (connection) => connection.id === fromA.id
          );
          const theirs = (await connectionsOf(b, bob.agentId)).find(
            (connection) => connection.id === fromB.id
          );
          return mine?.status === "active" && theirs?.status === "active";
        },
        2000
      );
      return "active on both sides";
    }
  );

  const slugOnA = `${fromA.slug}/${slugify(fromA.peerLabel ?? "")}`;
  const slugOnB = `${fromB.slug}/${slugify(fromB.peerLabel ?? "")}`;

  // 2. A messages B, B approves, the answer wakes A
  await check(
    "A -> B: held for approval on B, approved by a person, answered, and A's agent is woken",
    async () => {
      // A sends on its own, as the person allowed it (outbound auto).
      await a.person.mutate("a2a.setPolicies", {
        connectionId: fromA.id,
        outboundPolicy: "auto",
      });
      const session = `a-to-b-${Date.now()}`;
      const runId = await startRun(
        a,
        alice.agentId,
        sendTool(slugOnA, "say hello from alice"),
        session
      );
      const view = await waitForRun(a, runId);
      expect(
        view.status === "done",
        `A's run ended ${view.status}: ${view.error}`
      );
      expect(
        WAITING_WORDS.test(view.resultText ?? ""),
        `A's run did not say the message waits: ${view.resultText?.slice(0, 200)}`
      );
      // The message waits on B for a person. Nothing has run on B's agent.
      await waitUntil(
        "the message to wait on B",
        60_000,
        async () => {
          const waiting = await b.person.query<{ id: string; state: string }[]>(
            "a2a.recentTasks",
            { connectionId: fromB.id }
          );
          return waiting.some(
            (task) => task.state === "TASK_STATE_AUTH_REQUIRED"
          );
        },
        2000
      );
      expect(
        runsOf(b, bob.agentId).length === 0,
        "B's agent ran before anyone approved"
      );
      const waiting = (
        await b.person.query<{ id: string; state: string }[]>(
          "a2a.recentTasks",
          {
            connectionId: fromB.id,
          }
        )
      ).find((task) => task.state === "TASK_STATE_AUTH_REQUIRED");
      await b.person.mutate("a2a.approveMessage", {
        taskId: waiting?.id ?? "",
      });
      // B's agent answers, A's poll reads it, and A's ended run is woken.
      await tickBoth(
        "A's agent to be woken with the answer",
        [a, b],
        () => wokenBy(runsOf(a, alice.agentId), "hello from alice"),
        120_000
      );
      expect(
        runsOf(b, bob.agentId).some(
          (row) => row.result_text === "hello from alice"
        ),
        "B's agent did not answer with the text it was sent"
      );
      return "B's agent said it, and A's follow-up run carries the answer";
    }
  );

  // 3. B messages A through the outbound approval card
  await check(
    "B -> A: the outbound approval card is answered, A takes it, and B's agent is woken",
    async () => {
      await a.person.mutate("a2a.setPolicies", {
        connectionId: fromA.id,
        inboundPolicy: "auto",
      });
      const session = `b-to-a-${Date.now()}`;
      const runId = await startRun(
        b,
        bob.agentId,
        sendTool(slugOnB, "say hello from bob"),
        session
      );
      const view = await waitForRun(b, runId);
      expect(
        view.status === "done",
        `B's run ended ${view.status}: ${view.error}`
      );
      // The message waits for B's person: an approval card with the full text.
      let requestId = "";
      await waitUntil(
        "the approval card on B",
        60_000,
        async () => {
          const pending = await b.person.query<PendingRequest[]>(
            "requests.pending",
            {}
          );
          requestId = pending.at(0)?.id ?? "";
          return requestId !== "";
        },
        1500
      );
      await b.person.mutate("requests.answer", {
        decision: "allow_once",
        requestId,
      });
      await tickBoth(
        "B's agent to be woken with A's answer",
        [a, b],
        () => wokenBy(runsOf(b, bob.agentId), "hello from bob"),
        120_000
      );
      return "approved on B, taken on A, answered, B's follow-up run carries the answer";
    }
  );

  // 4. Revoke on A, both sides stop
  await check(
    "revoke on A: A's key stops working at once, then B's row shows it",
    async () => {
      await a.person.mutate("a2a.revoke", { connectionId: fromA.id });
      const mine = (await connectionsOf(a, alice.agentId)).find(
        (connection) => connection.id === fromA.id
      );
      expect(mine?.status === "revoked", `A's row is ${mine?.status}`);
      // The notice has not been delivered yet: B still thinks it is connected,
      // and A already refuses B's key.
      const stillActive = (await connectionsOf(b, bob.agentId)).find(
        (connection) => connection.id === fromB.id
      );
      expect(
        stillActive?.status === "active",
        `B's row is ${stillActive?.status} before A's notice`
      );
      const beforeNotice = await startRun(
        b,
        bob.agentId,
        sendTool(slugOnB, "say after revoke", 15_000),
        `after-revoke-${Date.now()}`
      );
      await waitForRun(b, beforeNotice);
      const refused = queryRows<{ state: string; result_text: string | null }>(
        b,
        "select state, result_text from a2a_outbound_tasks order by created_at desc limit 1"
      ).at(0);
      expect(
        refused?.state !== "TASK_STATE_COMPLETED",
        `A answered B after it revoked: ${refused?.result_text}`
      );
      expect(
        !runsOf(a, alice.agentId).some((row) =>
          row.input_text.includes("say after revoke")
        ),
        "A's agent was started by a message sent after the revoke"
      );
      // Now A's outbox delivers the notice, so B's page shows the state.
      await waitUntil(
        "B's row to show revoked",
        60_000,
        async () => {
          await a.tick();
          const theirs = (await connectionsOf(b, bob.agentId)).find(
            (connection) => connection.id === fromB.id
          );
          return theirs?.status === "revoked";
        },
        2000
      );
      return "refused before the notice, revoked on B after it";
    }
  );

  await check("revoke on A: A's agent cannot send to B either", async () => {
    const runId = await startRun(
      a,
      alice.agentId,
      sendTool(slugOnA, "say sent after revoke"),
      `a-after-revoke-${Date.now()}`
    );
    const view = await waitForRun(a, runId);
    expect(
      !runsOf(b, bob.agentId).some((row) =>
        row.input_text.includes("sent after revoke")
      ),
      "B's agent got a message from A after the revoke"
    );
    return `A's run said: ${(view.resultText ?? "").slice(0, 100)}`;
  });
};

const main = async (): Promise<number> => {
  const { values } = parseArgs({ options: { "work-dir": { type: "string" } } });
  const workDir = values["work-dir"] ?? defaultWorkDir();
  mkdirSync(workDir, { recursive: true });
  const a = createDeployment({
    name: "deployment-a",
    port: await freePort(),
    workDir,
  });
  const b = createDeployment({
    name: "deployment-b",
    port: await freePort(),
    workDir,
  });
  try {
    await Promise.all([a.start(), b.start()]);
    console.log(`A ${a.origin} (${a.stateDir})\nB ${b.origin} (${b.stateDir})`);
    await scenario(a, b);
  } finally {
    await Promise.all([a.stop(), b.stop()]);
  }
  await sleep(0);
  const failed = results.filter((result) => !result.ok);
  console.log(
    `\nTwo deployments: ${results.length - failed.length} of ${results.length} checks passed`
  );
  for (const result of failed) {
    console.log(`  FAIL ${result.name}: ${result.detail}`);
  }
  return failed.length === 0 ? 0 : 1;
};

if (import.meta.main) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  );
}
