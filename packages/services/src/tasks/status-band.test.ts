import { expect, test } from "bun:test";
import { call, event, run } from "./fixtures.test-helper.ts";
import { statusBand } from "./status-band.ts";

test("running names latest tool or Thinking", () => {
  expect(statusBand(run(), [], [])).toEqual({ tone: "running", text: "Thinking" });
  expect(statusBand(run(), [call("a", "web_search"), call("b", "read_file")], [])).toEqual({ tone: "running", text: "Read file" });
  expect(statusBand(run(), [call("a"), event("message.assistant", { text: "Done" })], []).text).toBe("Thinking");
});
test("waiting explains approval or question from pending records", () => {
  expect(statusBand(run({ status: "waiting" }), [], [{ kind: "approval", status: "pending", toolName: "write_file", display: { summary: "Write file" } }])).toEqual({ tone: "waiting", text: "Waiting for approval: Write file" });
  expect(statusBand(run({ status: "waiting" }), [], [{ kind: "question", status: "pending", toolName: "AskUserQuestion", display: { questions: [{ question: "Which file?" }] } }]).text).toBe("Waiting for an answer: Which file?");
});
test("terminal bands use run fields without events, stripping attachments", () => {
  expect(statusBand(run({ status: "done", resultText: "[ATTACHMENT:/file] Finished. More details." }), [], [])).toEqual({ tone: "ok", text: "Finished." });
  expect(statusBand(run({ status: "failed", error: "Could not connect. Retry later." }), [], [])).toEqual({ tone: "error", text: "Could not connect." });
});
test("queued, offered, interrupted, cancelled and empty terminal runs have fallbacks", () => {
  for (const status of ["queued", "offered", "interrupted", "cancelled", "done", "failed", "waiting"] as const) {
    expect(statusBand(run({ status }), [], []).text.length).toBeGreaterThan(0);
  }
});
