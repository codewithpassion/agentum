// Tests for the dry-run rules: which calls go through, how a skipped call is
// summarised and masked, and the wording of the skipped and ask_user texts.
import { describe, expect, test } from "bun:test";
import { createMasker } from "@repo/protocol/masker";
import {
  ASK_USER_DRY_RUN_TEXT,
  DRY_RUN_SUMMARY_MAX,
  isReadOnlyCall,
  skippedText,
  summaryOf,
} from "./pi-run-dry-run.ts";
import type { ToolOrigin } from "./pi-run-mcp.ts";

const origin = (readOnly: boolean): ToolOrigin => ({
  name: "read",
  readOnly,
  server: "docs",
});

describe("isReadOnlyCall with an MCP origin", () => {
  test("a connector tool marked read-only goes through", () => {
    expect(
      isReadOnlyCall({ arguments: {}, name: "anything" }, origin(true))
    ).toBe(true);
  });

  test("a connector tool not marked read-only is skipped, even when named read", () => {
    expect(isReadOnlyCall({ arguments: {}, name: "read" }, origin(false))).toBe(
      false
    );
  });
});

describe("isReadOnlyCall for built-in tools", () => {
  test("web_fetch with no method is read-only", () => {
    expect(isReadOnlyCall({ arguments: {}, name: "web_fetch" })).toBe(true);
  });

  test("web_fetch with GET in any case is read-only", () => {
    expect(
      isReadOnlyCall({ arguments: { method: "get" }, name: "web_fetch" })
    ).toBe(true);
    expect(
      isReadOnlyCall({ arguments: { method: "GET" }, name: "web_fetch" })
    ).toBe(true);
  });

  test("web_fetch with POST is skipped", () => {
    expect(
      isReadOnlyCall({ arguments: { method: "POST" }, name: "web_fetch" })
    ).toBe(false);
  });

  test("web_fetch with a method that is not a string is skipped", () => {
    expect(
      isReadOnlyCall({ arguments: { method: null }, name: "web_fetch" })
    ).toBe(false);
  });

  test.each([
    "read",
    "activate_skill",
    "desktop_screenshot",
    "read_input_file",
    "read_skill_resource",
  ])("%s is read-only", (name) => {
    expect(isReadOnlyCall({ arguments: {}, name })).toBe(true);
  });

  test.each([
    "write",
    "edit",
    "run_script",
    "run_skill_script",
    "bash",
    "mystery",
  ])("%s is skipped", (name) => {
    expect(isReadOnlyCall({ arguments: {}, name })).toBe(false);
  });
});

describe("summaryOf", () => {
  test("a short input is its JSON", () => {
    expect(summaryOf({ path: "a.txt" }, null)).toBe('{"path":"a.txt"}');
  });

  test("a long input is cut to the maximum and ends with an ellipsis", () => {
    const summary = summaryOf({ text: "x".repeat(500) }, null);
    expect(summary.length).toBeLessThanOrEqual(DRY_RUN_SUMMARY_MAX);
    expect(summary.length).toBe(DRY_RUN_SUMMARY_MAX);
    expect(summary.endsWith("…")).toBe(true);
  });

  test("a secret is replaced by the masker", () => {
    const masker = createMasker({ token: "hm_run_abc123" });
    expect(summaryOf({ auth: "hm_run_abc123" }, masker)).toBe(
      '{"auth":"[secret:token]"}'
    );
  });

  test("a secret across the cut point never appears in the summary", () => {
    const secret = "hm_run_abc123def456";
    const masker = createMasker({ token: secret });
    // The JSON prefix is 9 characters, so the secret starts before the cut
    // at 199 and ends after it.
    const args = { text: `${"a".repeat(185)}${secret}${"b".repeat(100)}` };
    const summary = summaryOf(args, masker);
    expect(summary).not.toContain(secret);
    expect(summary).not.toContain("hm_run_");
    expect(summary.length).toBeLessThanOrEqual(DRY_RUN_SUMMARY_MAX);
    expect(summary.endsWith("…")).toBe(true);
  });

  test("empty input gives no input", () => {
    expect(summaryOf({}, null)).toBe("no input");
  });
});

describe("skippedText and ASK_USER_DRY_RUN_TEXT", () => {
  test("skippedText gives the exact sentence", () => {
    expect(skippedText("bash", '{"cmd":"ls"}')).toBe(
      'Skipped in dry run: would call bash with {"cmd":"ls"}'
    );
  });

  test("the ask_user text is the exact sentence", () => {
    expect(ASK_USER_DRY_RUN_TEXT).toBe(
      "Nobody answers in a dry run. Go on with a stated assumption."
    );
  });
});
