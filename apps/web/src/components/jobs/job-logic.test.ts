import { describe, expect, test } from "bun:test";
import type { JobSentence, ProposedTrigger } from "@repo/db/shared";
import {
  canPause,
  canRunNow,
  draftChips,
  draftName,
  draftRoutineInput,
  draftSaveKind,
  jobChips,
  lastResultText,
} from "./job-logic";

const NOW_MS = Date.parse("2026-11-20T12:00:00Z");
const TWO_HOURS_AGO = "2026-11-20T10:00:00Z";

const job: Pick<
  JobSentence,
  "agent" | "asksBefore" | "deliversTo" | "does" | "when"
> = {
  agent: { id: "agt_1", name: "Digest" },
  asksBefore: "Dom",
  deliversTo: "#news",
  does: "Summarise the week",
  when: "Every Friday at 9:00",
};

const draft = (overrides: Partial<ProposedTrigger> = {}): ProposedTrigger => ({
  asksBefore: null,
  cron: "0 9 * * 1",
  deliversTo: null,
  does: "Send the report",
  source: "routine",
  timezone: null,
  when: "Every Monday at 9:00",
  ...overrides,
});

describe("jobChips", () => {
  test("orders when, agent, does, asks, delivers", () => {
    expect(jobChips(job, { showAgent: true })).toEqual([
      { kind: "when", text: "Every Friday at 9:00" },
      { kind: "agent", text: "Digest" },
      { kind: "does", text: "Summarise the week" },
      { kind: "asks", text: "Asks first: Dom" },
      { kind: "delivers", text: "Sends to #news" },
    ]);
  });

  test("omits the agent chip when showAgent is false", () => {
    const kinds = jobChips(job, { showAgent: false }).map((chip) => chip.kind);
    expect(kinds).toEqual(["when", "does", "asks", "delivers"]);
  });

  test("skips empty does, null or empty asks and delivers, and empty when", () => {
    const chips = jobChips(
      {
        ...job,
        asksBefore: "",
        deliversTo: null,
        does: "   ",
        when: "",
      },
      { showAgent: true }
    );
    expect(chips).toEqual([{ kind: "agent", text: "Digest" }]);
  });
});

describe("draftChips", () => {
  test("builds chips without an agent chip", () => {
    const chips = draftChips(
      draft({ asksBefore: "Dom", deliversTo: "#news", does: "Send it" })
    );
    expect(chips).toEqual([
      { kind: "when", text: "Every Monday at 9:00" },
      { kind: "does", text: "Send it" },
      { kind: "asks", text: "Asks first: Dom" },
      { kind: "delivers", text: "Sends to #news" },
    ]);
  });

  test("skips the empty parts of a draft", () => {
    const chips = draftChips(draft({ does: "", when: "  " }));
    expect(chips).toEqual([]);
  });
});

describe("lastResultText", () => {
  test("reports a job that has not run", () => {
    expect(lastResultText({ lastRunAt: null, lastRunOk: null }, NOW_MS)).toBe(
      "Not run yet"
    );
    expect(lastResultText({ lastRunAt: null, lastRunOk: null }, null)).toBe(
      "Not run yet"
    );
  });

  test("reports running, ok and failed with a relative time", () => {
    expect(
      lastResultText({ lastRunAt: TWO_HOURS_AGO, lastRunOk: null }, NOW_MS)
    ).toBe("Last run running, about 2 hours ago");
    expect(
      lastResultText({ lastRunAt: TWO_HOURS_AGO, lastRunOk: true }, NOW_MS)
    ).toBe("Last run ok, about 2 hours ago");
    expect(
      lastResultText({ lastRunAt: TWO_HOURS_AGO, lastRunOk: false }, NOW_MS)
    ).toBe("Last run failed, about 2 hours ago");
  });

  test("omits the relative time when nowMs is null", () => {
    expect(
      lastResultText({ lastRunAt: TWO_HOURS_AGO, lastRunOk: null }, null)
    ).toBe("Last run running");
    expect(
      lastResultText({ lastRunAt: TWO_HOURS_AGO, lastRunOk: true }, null)
    ).toBe("Last run ok");
    expect(
      lastResultText({ lastRunAt: TWO_HOURS_AGO, lastRunOk: false }, null)
    ).toBe("Last run failed");
  });
});

describe("canRunNow and canPause", () => {
  test("only routines run now", () => {
    expect(canRunNow({ source: "routine" })).toBe(true);
    expect(canRunNow({ source: "http" })).toBe(false);
    expect(canRunNow({ source: "mail" })).toBe(false);
    expect(canRunNow({ source: "app" })).toBe(false);
    expect(canRunNow({ source: "slack" })).toBe(false);
  });

  test("every source but slack can pause", () => {
    expect(canPause({ source: "routine" })).toBe(true);
    expect(canPause({ source: "http" })).toBe(true);
    expect(canPause({ source: "mail" })).toBe(true);
    expect(canPause({ source: "app" })).toBe(true);
    expect(canPause({ source: "slack" })).toBe(false);
  });
});

describe("draftSaveKind", () => {
  test("routine with a cron is a routine", () => {
    expect(draftSaveKind(draft({ source: "routine" }))).toBe("routine");
  });

  test("routine without a cron is unsupported", () => {
    expect(draftSaveKind(draft({ cron: null, source: "routine" }))).toBe(
      "unsupported"
    );
    expect(draftSaveKind(draft({ cron: "", source: "routine" }))).toBe(
      "unsupported"
    );
  });

  test("http and mail map to their own kinds", () => {
    expect(draftSaveKind(draft({ cron: null, source: "http" }))).toBe("http");
    expect(draftSaveKind(draft({ cron: null, source: "mail" }))).toBe("mail");
  });

  test("app and slack are unsupported", () => {
    expect(draftSaveKind(draft({ cron: null, source: "app" }))).toBe(
      "unsupported"
    );
    expect(draftSaveKind(draft({ cron: null, source: "slack" }))).toBe(
      "unsupported"
    );
  });
});

describe("draftName", () => {
  test("uses the first non-empty line, trimmed", () => {
    expect(draftName("\n   \n  Send the weekly report  \nSecond line")).toBe(
      "Send the weekly report"
    );
  });

  test("falls back when there is no text", () => {
    expect(draftName("")).toBe("New job");
    expect(draftName("  \n\t\n")).toBe("New job");
  });

  test("cuts a 200-character line to 80 characters", () => {
    const longLine = "a".repeat(200);
    expect(draftName(longLine)).toBe("a".repeat(80));
  });

  test("trims trailing space left by the cut", () => {
    const line = `${"b".repeat(79)} ${"c".repeat(20)}`;
    expect(draftName(line)).toBe("b".repeat(79));
  });
});

describe("draftRoutineInput", () => {
  test("builds the routine input with a timezone", () => {
    const input = draftRoutineInput(
      "agt_1",
      draft({ does: "  Send the report  ", timezone: "Europe/Zurich" })
    );
    expect(input).toEqual({
      agentId: "agt_1",
      cron: "0 9 * * 1",
      name: "Send the report",
      prompt: "Send the report",
      timezone: "Europe/Zurich",
    });
  });

  test("leaves timezone out when it is null", () => {
    const input = draftRoutineInput("agt_1", draft({ timezone: null }));
    expect(input).not.toHaveProperty("timezone");
    expect(input).toEqual({
      agentId: "agt_1",
      cron: "0 9 * * 1",
      name: "Send the report",
      prompt: "Send the report",
    });
  });

  test("uses the when text as the prompt when does is empty", () => {
    const input = draftRoutineInput(
      "agt_1",
      draft({ does: "   ", when: "  Every Monday  " })
    );
    expect(input.prompt).toBe("Every Monday");
    expect(input.name).toBe("New job");
  });

  test("throws when the cron is null", () => {
    expect(() => draftRoutineInput("agt_1", draft({ cron: null }))).toThrow(
      "A routine needs a cron schedule to be saved."
    );
  });

  test("throws when the cron is empty", () => {
    expect(() => draftRoutineInput("agt_1", draft({ cron: "" }))).toThrow(
      "A routine needs a cron schedule to be saved."
    );
  });
});
