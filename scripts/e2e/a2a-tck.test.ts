import { describe, expect, test } from "bun:test";
import { summarise } from "./a2a-tck.ts";

describe("summarise", () => {
  test("counts passed, failed, skipped and total requirements", () => {
    const summary = summarise({
      per_requirement: {
        "CORE-X-001": {
          level: "MUST",
          status: "PASS",
          transports: { jsonrpc: "PASS" },
        },
        "CORE-X-002": {
          level: "MUST",
          status: "FAIL",
          transports: { http_json: "PASS", jsonrpc: "FAIL" },
        },
        "CORE-X-003": { level: "MAY", status: "SKIPPED", transports: {} },
      },
    });
    expect(summary.passed).toBe(1);
    expect(summary.failed.length).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.total).toBe(3);
  });

  test("lists a failed requirement with only its failing transports", () => {
    const summary = summarise({
      per_requirement: {
        "CORE-X-002": {
          level: "MUST",
          status: "FAIL",
          transports: { http_json: "PASS", jsonrpc: "FAIL" },
        },
      },
    });
    expect(summary.failed).toEqual([
      { id: "CORE-X-002", level: "MUST", transports: ["jsonrpc"] },
    ]);
  });

  test("gives zeros for an empty report", () => {
    expect(summarise({})).toEqual({
      failed: [],
      passed: 0,
      skipped: 0,
      total: 0,
    });
  });
});
