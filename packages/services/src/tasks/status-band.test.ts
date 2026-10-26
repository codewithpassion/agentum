import { expect, test } from "bun:test";
import { call, event, run } from "./fixtures.test-helper.ts";
import { statusBand } from "./status-band.ts";

test("running names latest tool or Thinking", () => {
  expect(statusBand(run(), [], [])).toEqual({
    text: "Thinking",
    tone: "running",
  });
  expect(
    statusBand(run(), [call("a", "web_search"), call("b", "read_file")], [])
  ).toEqual({ text: "Read file", tone: "running" });
  expect(
    statusBand(
      run(),
      [call("a"), event("message.assistant", { text: "Done" })],
      []
    ).text
  ).toBe("Thinking");
});
test("waiting explains approval or question from pending records", () => {
  expect(
    statusBand(
      run({ status: "waiting" }),
      [],
      [
        {
          display: { summary: "Write file" },
          kind: "approval",
          status: "pending",
          toolName: "write_file",
        },
      ]
    )
  ).toEqual({ text: "Waiting for approval: Write file", tone: "waiting" });
  expect(
    statusBand(
      run({ status: "waiting" }),
      [],
      [
        {
          display: { questions: [{ question: "Which file?" }] },
          kind: "question",
          status: "pending",
          toolName: "AskUserQuestion",
        },
      ]
    ).text
  ).toBe("Waiting for an answer: Which file?");
});
test("terminal bands use run fields without events, stripping attachments", () => {
  expect(
    statusBand(
      run({
        resultText: "[ATTACHMENT:/file] Finished. More details.",
        status: "done",
      }),
      [],
      []
    )
  ).toEqual({ text: "Finished.", tone: "ok" });
  expect(
    statusBand(
      run({ error: "Could not connect. Retry later.", status: "failed" }),
      [],
      []
    )
  ).toEqual({ text: "Could not connect.", tone: "error" });
});
test("queued, offered, interrupted, cancelled and empty terminal runs have fallbacks", () => {
  for (const status of [
    "queued",
    "offered",
    "interrupted",
    "cancelled",
    "done",
    "failed",
    "waiting",
  ] as const) {
    expect(statusBand(run({ status }), [], []).text.length).toBeGreaterThan(0);
  }
});
