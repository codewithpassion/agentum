import {
  buildStepEvent,
  ingestUrl,
  parseStepInput,
  postResult,
} from "./lib.ts";

function fail(reason: string): never {
  console.log(`step failed: ${reason}`);
  process.exit(1);
}

const parsed = parseStepInput(process.argv[2]);
if (!parsed.ok) {
  fail(parsed.error);
}

const url = ingestUrl(process.env.CONTROL_PLANE_URL);
if (url === null) {
  fail("CONTROL_PLANE_URL is not set");
}

const runId = process.env.HM_RUN_ID || "unknown";
const event = buildStepEvent({ input: parsed.input, now: new Date(), runId });
const result = await postResult({ event, fetchFn: fetch, url });

if (!result.ok) {
  fail(result.message);
}

console.log(`step posted for ${parsed.input.incidentId}: ${result.message}`);
