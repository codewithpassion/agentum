import { expect, test } from "bun:test";
import type { Payload } from "./payload.ts";
import { personLabel, summarize } from "./summary.ts";

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

test("run.cancelled names the user who cancelled", () => {
  expect(summarize("run.cancelled", {}, { id: "alice", kind: "user" })).toBe(
    "Cancelled by user alice"
  );
});

test("run.cancelled shows the label of the user when one is given", () => {
  expect(
    summarize(
      "run.cancelled",
      {},
      { id: "user_1", kind: "user", label: "Dom Fretz" }
    )
  ).toBe("Cancelled by Dom Fretz");
});

test("personLabel prefers the trimmed name", () => {
  expect(personLabel({ email: "dom@example.com", name: "  Dom Fretz  " })).toBe(
    "Dom Fretz"
  );
});

test("personLabel falls back to the email when the name is blank", () => {
  expect(personLabel({ email: " dom@example.com ", name: "   " })).toBe(
    "dom@example.com"
  );
  expect(personLabel({ email: "dom@example.com", name: null })).toBe(
    "dom@example.com"
  );
});

test("personLabel is undefined when there is no name or email", () => {
  expect(personLabel({ email: null, name: null })).toBeUndefined();
  expect(personLabel({ email: " ", name: "" })).toBeUndefined();
  expect(personLabel(undefined)).toBeUndefined();
});

test("run.cancelled from the system or with no actor says so", () => {
  expect(summarize("run.cancelled", {}, { id: "sys", kind: "system" })).toBe(
    "Cancelled by the system"
  );
  expect(summarize("run.cancelled", {})).toBe("Cancelled");
});

test("run.limit_reached and run.repeat_stopped show their error text", () => {
  const limit = "Stopped after 100 turns, the agent's limit";
  const repeat = "Stopped, the agent repeated the same step";
  expect(summarize("run.limit_reached", { error: limit })).toBe(limit);
  expect(summarize("run.repeat_stopped", { error: repeat })).toBe(repeat);
});
