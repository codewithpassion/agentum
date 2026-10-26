#!/usr/bin/env bun
// Browser check for the Sessions page. It needs a dev server on the given URL
// (`bunx vite dev --port <port>` in apps/web, after `bunx wrangler d1 migrations
// apply DB --local`), the dev user from `bun run create-dev-user`, and the
// `agent-browser` CLI. It seeds two sessions of two fake agents straight into
// the local D1 database, as scripts/dev does, then drives the page as the dev
// user: both sessions show in the list, the agent filter narrows it to one, and a
// session row opens its latest run's task view.
// Run from apps/web: `bun run e2e:sessions [--server <url>] [--session <name>]`.
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
const DEFAULT_BROWSER_SESSION = "m91-sessions";
const TRAILING_SLASHES = /\/+$/;

class E2eError extends Error {}

const expect = (condition: boolean, message: string): void => {
  if (!condition) {
    throw new E2eError(message);
  }
};

interface Seeded {
  alphaAgentId: string;
  alphaName: string;
  alphaTitle: string;
  betaName: string;
  betaTitle: string;
}

/** Two fake agents, one session each. */
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
    const create = (name: string) =>
      agents.create(principal, {
        instructions: "Echoes whatever it is told.",
        model: "fake",
        name,
        runtime: "fake",
        slug: `${name.toLowerCase().replaceAll(" ", "-")}-${stamp}`,
      });
    const alpha = await create(`E2E Alpha ${stamp}`);
    const beta = await create(`E2E Beta ${stamp}`);
    const alphaTitle = `alpha question ${stamp}`;
    const betaTitle = `beta question ${stamp}`;

    await runs.startRun(principal, {
      agentId: alpha.id,
      input: { text: alphaTitle },
      session: { origin: "trigger" },
    });
    await runs.startRun(principal, {
      agentId: beta.id,
      input: { text: betaTitle },
      session: { origin: "routine" },
    });
    return {
      alphaAgentId: alpha.id,
      alphaName: alpha.name,
      alphaTitle,
      betaName: beta.name,
      betaTitle,
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
  const waitForText = (text: string) => ab("wait", "--text", text);
  const log = (line: string) => process.stdout.write(`${line}\n`);

  const seeded = await seed();
  log(`seeded ${seeded.alphaName} and ${seeded.betaName}`);
  try {
    await ab("open", `${server}/api/dev-login`);
    await ab("wait", "--url", `${server}/agents`);
    await ab("open", `${server}/sessions`);
    await waitForText(seeded.alphaTitle);
    const both = await pageText();
    expect(
      both.includes(seeded.alphaTitle) && both.includes(seeded.betaTitle),
      "both sessions should show in the list"
    );
    log("ok: both sessions are in the list");

    await ab("select", "#sessions-agent", seeded.alphaAgentId);
    await ab(
      "wait",
      "--fn",
      `!document.body.innerText.includes(${JSON.stringify(seeded.betaTitle)})`
    );
    const filtered = await pageText();
    expect(
      filtered.includes(seeded.alphaTitle) &&
        !filtered.includes(seeded.betaTitle),
      "the agent filter should leave only the first session"
    );
    log("ok: the agent filter leaves one session");

    await ab("find", "text", seeded.alphaTitle, "click");
    await ab("wait", "--fn", "location.pathname.startsWith('/tasks/')");
    await waitForText(seeded.alphaTitle);
    log("ok: the row opens the task view");
    log("sessions e2e passed");
  } finally {
    await ab("close").catch(() => undefined);
  }
};

runCli(main);
