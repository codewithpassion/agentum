#!/usr/bin/env bun
// Browser check for the Log page. It needs a dev server on the given URL
// (`bunx vite dev --port <port>` in apps/web, after `bunx wrangler d1 migrations
// apply DB --local`), the dev user from `bun run create-dev-user`, and the
// `agent-browser` CLI. It seeds two fake agents with one run each straight into
// the local D1 database, as scripts/dev does, then drives the page as the dev
// user: both runs' events show, the agent filter narrows them to one agent, the
// type filter narrows them to `message.user`, and the first row's session link
// opens the session transcript.
// Run from apps/web: `bun run e2e:log [--server <url>] [--session <name>]`.
// The URL also comes from HM_SERVER; the default is http://localhost:3000.
import { parseArgs } from "node:util";
import { sqliteAtomic } from "@repo/db/atomic";
import { createAgentsService } from "@repo/services/agents";
import { createEventsService } from "@repo/services/events";
import { createRunsService } from "@repo/services/runs";
import { systemClock } from "@repo/services/runs/types";
import { spawn } from "bun";
import {
  devUserPrincipal,
  memoryBlobs,
  openLocalDatabase,
  requireOrgId,
  runCli,
} from "../../../scripts/dev/local.ts";

const DEFAULT_SERVER = "http://localhost:3000";
const DEFAULT_BROWSER_SESSION = "m92-log";
const TRAILING_SLASHES = /\/+$/;

const LOG_EVENT_TYPE = "message.user";
const QUEUED_EVENT_TYPE = "run.queued";
const SESSION_LINK = '[data-testid="log-session-link"]';

class E2eError extends Error {}

const expect = (condition: boolean, message: string): void => {
  if (!condition) {
    throw new E2eError(message);
  }
};

interface Seeded {
  alphaAgentId: string;
  alphaName: string;
  alphaText: string;
  betaName: string;
  betaText: string;
}

/** Two fake agents, one run each. Their input texts are the events' summaries. */
const seed = async (): Promise<Seeded> => {
  const orgId = requireOrgId();
  const local = openLocalDatabase();
  try {
    const { db } = local;
    const principal = await devUserPrincipal(db, orgId);
    const stamp = Date.now();
    const events = createEventsService({ blobs: memoryBlobs(), db });
    const agents = createAgentsService({ db, events });
    const runs = createRunsService({
      adapters: [],
      atomic: sqliteAtomic(db),
      blobs: memoryBlobs(),
      clock: systemClock,
      db,
      devFakeRuntime: true,
      gateways: [],
    });
    const create = (label: string) =>
      agents.create(principal, {
        instructions: "Echoes whatever it is told.",
        model: "fake",
        name: `E2E Log ${label} ${stamp}`,
        runtime: "fake",
        slug: `e2e-log-${label.toLowerCase()}-${stamp}`,
      });
    const alpha = await create("Alpha");
    const beta = await create("Beta");
    const alphaText = `alpha log ${stamp}`;
    const betaText = `beta log ${stamp}`;

    await runs.startRun(principal, {
      agentId: alpha.id,
      input: { text: alphaText },
      session: { origin: "trigger" },
    });
    await runs.startRun(principal, {
      agentId: beta.id,
      input: { text: betaText },
      session: { origin: "routine" },
    });
    return {
      alphaAgentId: alpha.id,
      alphaName: alpha.name,
      alphaText,
      betaName: beta.name,
      betaText,
    };
  } finally {
    local.close();
  }
};

const main = async (): Promise<void> => {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { server: { type: "string" }, session: { type: "string" } },
    strict: true,
  });
  const server = (
    values.server ??
    process.env.HM_SERVER ??
    DEFAULT_SERVER
  ).replace(TRAILING_SLASHES, "");
  const browser = values.session ?? DEFAULT_BROWSER_SESSION;

  const ab = async (...args: string[]): Promise<string> => {
    const proc = spawn(["agent-browser", "--session", browser, ...args], {
      stderr: "pipe",
      stdout: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      throw new E2eError(
        `agent-browser ${args.join(" ")} failed: ${err}${out}`
      );
    }
    return out;
  };
  const pageText = () => ab("eval", "document.body.innerText");
  // The type select lists every event type, so its options stay in the page
  // text. Read the table rows only when the check is about what rows show.
  const ROWS_TEXT =
    "[...document.querySelectorAll('[data-testid=\"log-row\"]')].map((row) => row.innerText).join('\\n')";
  const rowsText = () => ab("eval", ROWS_TEXT);
  const waitForText = (text: string) => ab("wait", "--text", text);
  const waitForGone = (text: string) =>
    ab(
      "wait",
      "--fn",
      `!document.body.innerText.includes(${JSON.stringify(text)})`
    );
  const log = (line: string) => process.stdout.write(`${line}\n`);

  const seeded = await seed();
  log(`seeded ${seeded.alphaName} and ${seeded.betaName}`);
  try {
    await ab("open", `${server}/api/dev-login`);
    await ab("wait", "--url", `${server}/agents`);
    await ab("open", `${server}/log`);
    await waitForText(seeded.alphaText);
    const both = await pageText();
    expect(
      both.includes(seeded.alphaText) && both.includes(seeded.betaText),
      "both runs' events should show in the log"
    );
    log("ok: both runs' events are in the log");

    await ab("select", "#log-agent", seeded.alphaAgentId);
    await waitForGone(seeded.betaText);
    const filtered = await pageText();
    expect(
      filtered.includes(seeded.alphaText) &&
        !filtered.includes(seeded.betaText),
      "the agent filter should leave only the alpha events"
    );
    log("ok: the agent filter leaves only the alpha events");

    await ab("select", "#log-agent", "");
    await ab("select", "#log-type", LOG_EVENT_TYPE);
    await ab(
      "wait",
      "--fn",
      `!(${ROWS_TEXT}).includes(${JSON.stringify(QUEUED_EVENT_TYPE)})`
    );
    const typed = await rowsText();
    expect(
      typed.includes(LOG_EVENT_TYPE) && !typed.includes(QUEUED_EVENT_TYPE),
      "the type filter should leave only message.user events"
    );
    log("ok: the type filter leaves only message.user events");

    await ab("find", "first", SESSION_LINK, "click");
    await ab(
      "wait",
      "--fn",
      "location.pathname === '/sessions' && location.search.includes('session=')"
    );
    await ab(
      "wait",
      "--fn",
      `document.body.innerText.includes(${JSON.stringify(seeded.alphaText)}) || document.body.innerText.includes(${JSON.stringify(seeded.betaText)})`
    );
    log("ok: the session link opens the transcript");
    log("log e2e passed");
  } finally {
    await ab("close").catch(() => undefined);
  }
};

runCli(main);
