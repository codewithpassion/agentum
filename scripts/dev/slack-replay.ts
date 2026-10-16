#!/usr/bin/env bun
// Replays a Slack event fixture at the local events route, signed with the
// app's signing secret the way Slack signs its requests. Prints the run id on
// stdout when the event started a run, the challenge text for a
// url_verification fixture, or `no run` when the route answered ok without a
// run. A non-200 answer goes to stderr and exits 1. Run from the repo root:
// `bun scripts/dev/slack-replay.ts <fixture> --secret <signing secret> [--url <events url>] [--fresh]`.
// A fixture path is tried as given, then under scripts/dev/.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { signSlackBody } from "@repo/services/slack/signature";
import { LocalError, runCli } from "./local.ts";

const DEFAULT_URL = "http://localhost:3000/api/slack/events";
const OK_STATUS = 200;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ReplayInput {
  fetch: FetchLike;
  fixturePath: string;
  /** Replace `event_id` with a new id, so the route does not dedupe the event. */
  fresh: boolean;
  /** Milliseconds since the epoch, for the signed timestamp. */
  now: number;
  secret: string;
  url: string;
}

export interface ReplayResult {
  /** The line to print: the run id, the challenge, `no run`, or the error. */
  output: string;
  status: number;
}

/** The file a fixture path names: as given, else under scripts/dev. */
export const resolveFixture = (fixturePath: string): string => {
  const candidates = isAbsolute(fixturePath)
    ? [fixturePath]
    : [resolve(fixturePath), join(import.meta.dir, fixturePath)];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new LocalError(`No fixture at ${candidates.join(" or ")}.`);
  }
  return found;
};

/** The body with `event_id` replaced. A body without one is returned as is. */
const withFreshEventId = (body: string): string => {
  const payload = JSON.parse(body) as Record<string, unknown>;
  if (!("event_id" in payload)) {
    return body;
  }
  const random = crypto.randomUUID().replaceAll("-", "").toUpperCase();
  payload.event_id = `Ev${random}`;
  return JSON.stringify(payload, null, 2);
};

/** The parsed value, or undefined when the text is not JSON. */
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON, so the caller reads the text as it is.
  }
};

/** What to print for a 200 answer: the run id, `no run`, or the challenge text. */
const answerLine = (text: string): string => {
  const parsed = parseJson(text);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("ok" in parsed) ||
    parsed.ok !== true
  ) {
    return text;
  }
  return "runId" in parsed &&
    typeof parsed.runId === "string" &&
    parsed.runId !== ""
    ? parsed.runId
    : "no run";
};

/** Posts a signed copy of a fixture to the events route and reports the answer. */
export const replayFixture = async ({
  fetch,
  fixturePath,
  fresh,
  now,
  secret,
  url,
}: ReplayInput): Promise<ReplayResult> => {
  const raw = readFileSync(resolveFixture(fixturePath), "utf8");
  const body = fresh ? withFreshEventId(raw) : raw;
  const timestamp = String(Math.floor(now / 1000));
  const signature = await signSlackBody({
    body,
    signingSecret: secret,
    timestamp,
  });
  const response = await fetch(url, {
    body,
    headers: {
      "Content-Type": "application/json",
      "X-Slack-Request-Timestamp": timestamp,
      "X-Slack-Signature": signature,
    },
    method: "POST",
  });
  const text = await response.text();
  if (response.status !== OK_STATUS) {
    return {
      output: `HTTP ${response.status}: ${text}`,
      status: response.status,
    };
  }
  return { output: answerLine(text), status: response.status };
};

export const main = async (argv: string[]): Promise<void> => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    args: argv,
    options: {
      fresh: { type: "boolean" },
      secret: { type: "string" },
      url: { type: "string" },
    },
  });
  const [fixturePath] = positionals;
  if (!fixturePath) {
    throw new LocalError("Pass a fixture, such as fixtures/mention.json.");
  }
  if (!values.secret) {
    throw new LocalError(
      "Pass --secret <signing secret>, the one seed-slack-app.ts printed."
    );
  }
  const result = await replayFixture({
    fetch,
    fixturePath,
    fresh: values.fresh ?? false,
    now: Date.now(),
    secret: values.secret,
    url: values.url ?? DEFAULT_URL,
  });
  if (result.status !== OK_STATUS) {
    throw new LocalError(result.output);
  }
  process.stdout.write(`${result.output}\n`);
};

if (import.meta.main) {
  runCli(() => main(process.argv.slice(2)));
}
