import { describe, expect, test } from "bun:test";
import {
  describeSchedule,
  formatInZone,
  formatUntil,
  nextRuns,
} from "./schedule-format";

const ZURICH = "Europe/Zurich";

describe("describeSchedule", () => {
  test("names the zone for everything anchored to a wall clock", () => {
    expect(
      describeSchedule(
        { time: "09:00", type: "daily", weekdaysOnly: true },
        ZURICH
      )
    ).toBe("Every weekday at 09:00 (Europe/Zurich)");
    expect(describeSchedule({ time: "09:00", type: "daily" }, ZURICH)).toBe(
      "Every day at 09:00 (Europe/Zurich)"
    );
    expect(
      describeSchedule({ day: 1, time: "14:00", type: "weekly" }, ZURICH)
    ).toBe("Mondays at 14:00 (Europe/Zurich)");
  });

  test("leaves an interval unzoned, and counts it in the largest whole unit", () => {
    expect(
      describeSchedule({ everyMinutes: 120, type: "interval" }, ZURICH)
    ).toBe("Every 2 hours");
    expect(
      describeSchedule({ everyMinutes: 60, type: "interval" }, ZURICH)
    ).toBe("Every 1 hour");
    expect(
      describeSchedule({ everyMinutes: 90, type: "interval" }, ZURICH)
    ).toBe("Every 90 minutes");
    expect(
      describeSchedule({ everyMinutes: 1440, type: "interval" }, ZURICH)
    ).toBe("Every 1 day");
  });

  test("reads a once off its own wall clock, not the reader's", () => {
    const text = describeSchedule(
      { at: "2026-08-21T15:00", type: "once" },
      ZURICH
    );
    expect(text).toStartWith("Once: ");
    expect(text).toContain("2026");
    expect(text).toContain("15:00");
    expect(text).toEndWith("(Europe/Zurich)");
  });

  test("shows a cron expression raw", () => {
    expect(
      describeSchedule({ expr: "0 9 * * 1-5", type: "cron" }, ZURICH)
    ).toBe("Cron: 0 9 * * 1-5 (Europe/Zurich)");
  });

  test("says so rather than throwing when the stored schedule no longer parses", () => {
    expect(describeSchedule(null, ZURICH)).toBe("Unreadable schedule");
  });
});

describe("nextRuns", () => {
  const after = new Date("2026-08-21T06:00:00Z");

  test("walks a repeating schedule forward, each run found from the last", () => {
    const runs = nextRuns({ time: "09:00", type: "daily" }, ZURICH, 3, after);
    expect(runs).toHaveLength(3);
    expect(runs[0]?.toISOString()).toBe("2026-08-21T07:00:00.000Z");
    expect(runs[1]?.toISOString()).toBe("2026-08-22T07:00:00.000Z");
    expect(runs[2]?.toISOString()).toBe("2026-08-23T07:00:00.000Z");
  });

  test("skips the weekend for a weekdays-only schedule", () => {
    // 21 August 2026 is a Friday, so the run after it is the Monday.
    const runs = nextRuns(
      { time: "09:00", type: "daily", weekdaysOnly: true },
      ZURICH,
      2,
      after
    );
    expect(runs[1]?.toISOString()).toBe("2026-08-24T07:00:00.000Z");
  });

  test("gives a once exactly one run, and a spent once none at all", () => {
    expect(
      nextRuns({ at: "2026-08-21T15:00", type: "once" }, ZURICH, 3, after)
    ).toHaveLength(1);
    expect(
      nextRuns({ at: "2020-01-01T15:00", type: "once" }, ZURICH, 3, after)
    ).toHaveLength(0);
  });

  test("answers with nothing when the zone is not a zone", () => {
    expect(
      nextRuns({ time: "09:00", type: "daily" }, "Mars/Olympus", 3, after)
    ).toHaveLength(0);
  });
});

describe("formatUntil", () => {
  const now = Date.UTC(2026, 7, 21, 12, 0, 0);
  const ahead = (ms: number) => formatUntil(now + ms, now);

  test("counts down through the units", () => {
    expect(ahead(30 * 1000)).toBe("in under a minute");
    expect(ahead(5 * 60_000)).toBe("in 5m");
    expect(ahead(3 * 3_600_000)).toBe("in 3h");
    expect(ahead(2 * 86_400_000)).toBe("in 2d");
  });

  test("a slot already past is due, not negative", () => {
    expect(ahead(-60_000)).toBe("due now");
  });
});

describe("formatInZone", () => {
  test("renders the instant as that zone reads it", () => {
    const summer = Date.UTC(2026, 7, 21, 7, 0, 0);
    expect(formatInZone(summer, ZURICH)).toContain("09:00");
    expect(formatInZone(summer, "UTC")).toContain("07:00");
  });

  test("falls back instead of throwing on an unknown zone", () => {
    expect(formatInZone(Date.now(), "Mars/Olympus")).not.toBe("");
  });
});
