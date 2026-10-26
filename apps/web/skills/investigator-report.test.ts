import { describe, expect, test } from "bun:test";
import {
  buildEvent,
  ingestUrl,
  parseReportInput,
  postResult,
} from "./investigator-report/scripts/lib.ts";

const ID = "inc_01HZX0Y1Z2A3B4C5D6E7F8G9H0";

function reportJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    incidentId: ID,
    outcome: "fixed",
    steps: ["checked logs", "restarted worker"],
    summary: "Restarted the worker.",
    ...overrides,
  });
}

describe("parseReportInput", () => {
  test("accepts a valid report", () => {
    expect(parseReportInput(reportJson())).toEqual({
      input: {
        incidentId: ID,
        outcome: "fixed",
        steps: ["checked logs", "restarted worker"],
        summary: "Restarted the worker.",
      },
      ok: true,
    });
  });

  test("treats missing steps as an empty list", () => {
    const raw = JSON.stringify({
      incidentId: ID,
      outcome: "escalate",
      summary: "Unsure.",
    });
    expect(parseReportInput(raw)).toEqual({
      input: {
        incidentId: ID,
        outcome: "escalate",
        steps: [],
        summary: "Unsure.",
      },
      ok: true,
    });
  });

  test("rejects an incident id that does not match", () => {
    expect(parseReportInput(reportJson({ incidentId: "inc_short" })).ok).toBe(
      false
    );
    expect(
      parseReportInput(
        reportJson({ incidentId: "xyz_01HZX0Y1Z2A3B4C5D6E7F8G9H0" })
      ).ok
    ).toBe(false);
    expect(parseReportInput(reportJson({ incidentId: 42 })).ok).toBe(false);
  });

  test("rejects an outcome other than fixed or escalate", () => {
    const result = parseReportInput(reportJson({ outcome: "done" }));
    expect(result.ok).toBe(false);
  });

  test("rejects an empty or non-string summary", () => {
    expect(parseReportInput(reportJson({ summary: "   " })).ok).toBe(false);
    expect(parseReportInput(reportJson({ summary: 7 })).ok).toBe(false);
  });

  test("rejects non-JSON input", () => {
    expect(parseReportInput("not json").ok).toBe(false);
  });

  test("rejects undefined input", () => {
    expect(parseReportInput(undefined).ok).toBe(false);
  });

  test("rejects input that is not an object", () => {
    expect(parseReportInput("[]").ok).toBe(false);
    expect(parseReportInput("null").ok).toBe(false);
    expect(parseReportInput('"text"').ok).toBe(false);
  });

  test("rejects steps that are not an array of strings", () => {
    expect(parseReportInput(reportJson({ steps: "one" })).ok).toBe(false);
    expect(parseReportInput(reportJson({ steps: ["ok", 3] })).ok).toBe(false);
  });

  test("cuts the summary to 2000 UTF-16 units, the way control-plane counts, without a lone surrogate", () => {
    const result = parseReportInput(reportJson({ summary: "😀".repeat(2500) }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.summary.length).toBeLessThanOrEqual(2000);
      expect(result.input.summary.isWellFormed()).toBe(true);
      expect(Array.from(result.input.summary)).toHaveLength(1000);
    }
  });

  test("a cut through a surrogate pair drops the orphan half", () => {
    const result = parseReportInput(
      reportJson({ summary: `${"x".repeat(1999)}😀` })
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.summary).toBe("x".repeat(1999));
    }
  });

  test("keeps the first 50 steps and cuts each to 500 UTF-16 units", () => {
    const steps = Array.from(
      { length: 60 },
      (_, i) => `${i}-${"x".repeat(600)}`
    );
    const result = parseReportInput(reportJson({ steps }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.steps).toHaveLength(50);
      expect(result.input.steps[0]?.startsWith("0-")).toBe(true);
      expect(result.input.steps[49]?.startsWith("49-")).toBe(true);
      for (const step of result.input.steps) {
        expect(step).toHaveLength(500);
      }
    }
  });
});

describe("buildEvent", () => {
  const now = new Date("2026-10-26T10:00:00.000Z");
  const input = {
    incidentId: ID,
    outcome: "fixed" as const,
    steps: ["checked logs"],
    summary: "Restarted the worker.",
  };

  test("builds the exact event object", () => {
    expect(buildEvent({ input, now, runId: "run_1" })).toEqual({
      actor: { id: "harbourmaster-investigator", kind: "agent" },
      correlation_id: ID,
      fingerprint: `hm-investigator:${ID}`,
      payload: {
        incidentId: ID,
        outcome: "fixed",
        runId: "run_1",
        steps: ["checked logs"],
        summary: "Restarted the worker.",
      },
      severity: "info",
      source: "agent",
      summary: "Restarted the worker.",
      system_id: null,
      ts: "2026-10-26T10:00:00.000Z",
      type: "investigation.result",
    });
  });

  test("collapses whitespace and removes control characters in the event summary", () => {
    const event = buildEvent({
      input: { ...input, summary: "  Line one\n\nline\ttwo\u0007  " },
      now,
      runId: "run_1",
    });
    expect(event.summary).toBe("Line one line two");
    expect(event.payload.summary).toBe("  Line one\n\nline\ttwo\u0007  ");
  });

  test("cuts the event summary to 200 code points", () => {
    const event = buildEvent({
      input: { ...input, summary: "😀".repeat(300) },
      now,
      runId: "r",
    });
    expect(Array.from(event.summary)).toHaveLength(200);
  });

  test("the event summary has no format characters or lone surrogates, which control-plane refuses", () => {
    const event = buildEvent({
      input: {
        ...input,
        summary: "soft\u00ADhyphen\u200Bzero\uFEFFbom lone\uD83D end",
      },
      now,
      runId: "r",
    });
    expect(event.summary).toBe("softhyphenzero bom lone end");
  });

  test("falls back to Investigation <outcome> when the summary is empty after cleanup", () => {
    const event = buildEvent({
      input: { ...input, outcome: "escalate", summary: "\n\u0001 \t" },
      now,
      runId: "r",
    });
    expect(event.summary).toBe("Investigation escalate");
  });
});

describe("ingestUrl", () => {
  test("appends the ingest path and drops trailing slashes", () => {
    expect(ingestUrl("https://controlplane.example.com")).toBe(
      "https://controlplane.example.com/ingest/events"
    );
    expect(ingestUrl("https://controlplane.example.com//")).toBe(
      "https://controlplane.example.com/ingest/events"
    );
  });

  test("returns null for a missing or empty base", () => {
    expect(ingestUrl(undefined)).toBeNull();
    expect(ingestUrl("")).toBeNull();
  });
});

describe("postResult", () => {
  const event = buildEvent({
    input: { incidentId: ID, outcome: "fixed", steps: [], summary: "Done." },
    now: new Date("2026-10-26T10:00:00.000Z"),
    runId: "run_1",
  });
  const url = "https://controlplane.example.com/ingest/events";

  test("reports success on a 2xx response and sends the event without Authorization", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (
      requestUrl: string,
      init: RequestInit
    ): Promise<Response> => {
      calls.push({ init, url: requestUrl });
      return Promise.resolve(new Response("{}", { status: 202 }));
    };

    const result = await postResult({ event, fetchFn: fakeFetch, url });

    expect(result.ok).toBe(true);
    expect(result.message).toContain("202");
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(url);
    expect(call?.init.method).toBe("POST");
    const headers = call?.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain(
      "authorization"
    );
    expect(call?.init.body).toBe(JSON.stringify(event));
  });

  test("reports the status and response text on a non-2xx response", async () => {
    const fakeFetch = (): Promise<Response> =>
      Promise.resolve(new Response("internal\n  failure", { status: 500 }));

    const result = await postResult({ event, fetchFn: fakeFetch, url });

    expect(result.ok).toBe(false);
    expect(result.message).toBe("HTTP 500: internal failure");
  });

  test("cuts the response text to 200 characters", async () => {
    const fakeFetch = (): Promise<Response> =>
      Promise.resolve(new Response("e".repeat(500), { status: 503 }));

    const result = await postResult({ event, fetchFn: fakeFetch, url });

    expect(result.ok).toBe(false);
    expect(result.message).toBe(`HTTP 503: ${"e".repeat(200)}`);
  });

  test("reports a rejected fetch as request failed", async () => {
    const fakeFetch = (): Promise<Response> =>
      Promise.reject(new Error("connection reset"));

    const result = await postResult({ event, fetchFn: fakeFetch, url });

    expect(result).toEqual({
      message: "request failed: connection reset",
      ok: false,
    });
  });
});
