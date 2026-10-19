import { expect, test } from "bun:test";
import type { Payload } from "./payload.ts";
import { summarize } from "./summary.ts";

const SUMMARY_MAX = 120;
const SIGNATURE_SUMMARY =
  "Slack event refused: signature didn't match. Check the signing secret in the agent's Slack settings.";
const TEAM_SUMMARY =
  "Slack event refused: wrong Slack workspace for this agent's app. Check where the app is installed.";

test("signature refusal gives the signing secret hint", () => {
  expect(summarize("slack.event_refused", { reason: "signature" })).toBe(
    SIGNATURE_SUMMARY
  );
});

test("team refusal gives the workspace hint", () => {
  expect(summarize("slack.event_refused", { reason: "team" })).toBe(
    TEAM_SUMMARY
  );
});

test("refusal sentences fit under the summary limit", () => {
  expect(SIGNATURE_SUMMARY.length).toBeLessThan(SUMMARY_MAX);
  expect(TEAM_SUMMARY.length).toBeLessThan(SUMMARY_MAX);
});

test("unknown or missing refusal reason gives the generic sentence", () => {
  expect(summarize("slack.event_refused", { reason: "other" })).toBe(
    "Slack event refused."
  );
  expect(summarize("slack.event_refused", { reason: 7 })).toBe(
    "Slack event refused."
  );
  expect(summarize("slack.event_refused", {})).toBe("Slack event refused.");
});

test("other types still summarize from the first non-empty text field", () => {
  const payload: Payload = { error: "boom", name: "ignored" };
  expect(summarize("run.failed", payload)).toBe("boom");
});

test("other types ignore a reason field that matches a refusal", () => {
  expect(summarize("run.failed", { reason: "signature" })).toBe("signature");
});

test("other types cut long text to 120 characters with an ellipsis", () => {
  const long = "a".repeat(200);
  expect(summarize("run.failed", { error: long })).toBe(
    `${"a".repeat(SUMMARY_MAX)}...`
  );
});

test("other types collapse whitespace and skip blank fields", () => {
  expect(summarize("run.failed", { error: " a \n  b ", text: "   " })).toBe(
    "a b"
  );
});
