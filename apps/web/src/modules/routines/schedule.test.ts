import { describe, expect, test } from "bun:test";
import {
  MIN_INTERVAL_MINUTES,
  nextRun,
  parseSchedule,
  type Schedule,
} from "./schedule";

/**
 * The schedule engine, and daylight saving above all: a routine promises a wall
 * clock ("every weekday at 09:00"), so the instant it fires at has to move when
 * the zone does. The two transitions worth testing are the ones that break
 * naive `+24h` arithmetic - the hour that never happens, and the one that
 * happens twice.
 *
 * 2026 transitions used below:
 *   America/New_York  8 March (02:00 EST -> 03:00 EDT), 1 November (back)
 *   Europe/Zurich    29 March (02:00 CET -> 03:00 CEST), 25 October (back)
 */

const NEW_YORK = "America/New_York";
const ZURICH = "Europe/Zurich";

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

const from = (value: string): Date => new Date(value);

const daily = (time: string, weekdaysOnly = false): Schedule => ({
  time,
  type: "daily",
  weekdaysOnly,
});

describe("daily, across a spring-forward transition", () => {
  test("New York keeps 09:00 local, which is an hour earlier in UTC", () => {
    // The day before the change: 09:00 EST is 14:00 UTC.
    expect(
      iso(nextRun(daily("09:00"), NEW_YORK, from("2026-03-07T00:00:00Z")))
    ).toBe("2026-03-07T14:00:00.000Z");
    // The morning of it: the same wall clock, now EDT, is 13:00 UTC.
    expect(
      iso(nextRun(daily("09:00"), NEW_YORK, from("2026-03-07T15:00:00Z")))
    ).toBe("2026-03-08T13:00:00.000Z");
  });

  test("Zurich does the same on its own date", () => {
    expect(
      iso(nextRun(daily("09:00"), ZURICH, from("2026-03-28T09:00:00Z")))
    ).toBe("2026-03-29T07:00:00.000Z");
    expect(
      iso(nextRun(daily("09:00"), ZURICH, from("2026-03-27T00:00:00Z")))
    ).toBe("2026-03-27T08:00:00.000Z");
  });

  test("a wall clock the transition skipped still fires, an hour along", () => {
    // 02:30 does not exist on 8 March in New York; the routine fires at 03:30
    // EDT (07:30 UTC) rather than being silently dropped for the day.
    expect(
      iso(nextRun(daily("02:30"), NEW_YORK, from("2026-03-08T06:00:00Z")))
    ).toBe("2026-03-08T07:30:00.000Z");
    // Zurich, 29 March: 02:30 CET does not exist either -> 03:30 CEST.
    expect(
      iso(nextRun(daily("02:30"), ZURICH, from("2026-03-29T00:45:00Z")))
    ).toBe("2026-03-29T01:30:00.000Z");
  });
});

describe("daily, across a fall-back transition", () => {
  test("a wall clock that happens twice fires on the first of them", () => {
    // 01:30 comes round twice on 1 November in New York: 05:30 UTC (EDT) and
    // 06:30 UTC (EST). One fire, the earlier one.
    expect(
      iso(nextRun(daily("01:30"), NEW_YORK, from("2026-11-01T04:00:00Z")))
    ).toBe("2026-11-01T05:30:00.000Z");
    // Zurich, 25 October: 02:30 CEST (00:30 UTC) before 02:30 CET (01:30 UTC).
    expect(
      iso(nextRun(daily("02:30"), ZURICH, from("2026-10-24T23:00:00Z")))
    ).toBe("2026-10-25T00:30:00.000Z");
  });

  test("and the day after the change is back to the winter offset", () => {
    expect(
      iso(nextRun(daily("09:00"), NEW_YORK, from("2026-11-01T20:00:00Z")))
    ).toBe("2026-11-02T14:00:00.000Z");
    expect(
      iso(nextRun(daily("09:00"), ZURICH, from("2026-10-25T12:00:00Z")))
    ).toBe("2026-10-26T08:00:00.000Z");
  });
});

describe("weekdaysOnly", () => {
  test("skips Saturday and Sunday", () => {
    // Friday 2026-08-21, after 09:00 local -> Monday the 24th.
    expect(
      iso(nextRun(daily("09:00", true), ZURICH, from("2026-08-21T08:00:00Z")))
    ).toBe("2026-08-24T07:00:00.000Z");
  });

  test("without it, the weekend fires too", () => {
    expect(
      iso(nextRun(daily("09:00"), ZURICH, from("2026-08-21T08:00:00Z")))
    ).toBe("2026-08-22T07:00:00.000Z");
  });
});

describe("weekly", () => {
  test("finds the next matching weekday, this week or next", () => {
    const monday: Schedule = { day: 1, time: "09:00", type: "weekly" };
    // Friday -> the coming Monday.
    expect(iso(nextRun(monday, ZURICH, from("2026-08-21T08:00:00Z")))).toBe(
      "2026-08-24T07:00:00.000Z"
    );
    // Monday, before the time -> today.
    expect(iso(nextRun(monday, ZURICH, from("2026-08-24T05:00:00Z")))).toBe(
      "2026-08-24T07:00:00.000Z"
    );
    // Monday, after it -> a week out.
    expect(iso(nextRun(monday, ZURICH, from("2026-08-24T08:00:00Z")))).toBe(
      "2026-08-31T07:00:00.000Z"
    );
  });

  test("Sunday is 0", () => {
    const sunday: Schedule = { day: 0, time: "18:00", type: "weekly" };
    expect(iso(nextRun(sunday, ZURICH, from("2026-08-21T08:00:00Z")))).toBe(
      "2026-08-23T16:00:00.000Z"
    );
  });
});

describe("once", () => {
  test("resolves the local wall clock in the routine's zone", () => {
    const schedule: Schedule = { at: "2026-08-21T14:30", type: "once" };
    expect(iso(nextRun(schedule, ZURICH, from("2026-08-21T00:00:00Z")))).toBe(
      "2026-08-21T12:30:00.000Z"
    );
    expect(iso(nextRun(schedule, NEW_YORK, from("2026-08-21T00:00:00Z")))).toBe(
      "2026-08-21T18:30:00.000Z"
    );
  });

  test("in the past there is no next run at all", () => {
    const schedule: Schedule = { at: "2026-08-21T14:30", type: "once" };
    expect(nextRun(schedule, ZURICH, from("2026-08-21T13:00:00Z"))).toBeNull();
    // Including its own instant: `after` is exclusive.
    expect(nextRun(schedule, ZURICH, from("2026-08-21T12:30:00Z"))).toBeNull();
  });
});

describe("interval", () => {
  test("counts from `after`, so a missed slot never replays", () => {
    const schedule: Schedule = { everyMinutes: 30, type: "interval" };
    expect(iso(nextRun(schedule, ZURICH, from("2026-08-21T12:00:00Z")))).toBe(
      "2026-08-21T12:30:00.000Z"
    );
  });

  test("a stored interval below the floor stops firing", () => {
    const schedule: Schedule = { everyMinutes: 5, type: "interval" };
    expect(nextRun(schedule, ZURICH, from("2026-08-21T12:00:00Z"))).toBeNull();
  });
});

describe("cron", () => {
  const cron = (expr: string): Schedule => ({ expr, type: "cron" });

  test("weekday mornings", () => {
    expect(
      iso(nextRun(cron("0 9 * * 1-5"), ZURICH, from("2026-08-21T08:00:00Z")))
    ).toBe("2026-08-24T07:00:00.000Z");
  });

  test("a step runs through the hour", () => {
    expect(
      iso(nextRun(cron("*/15 * * * *"), ZURICH, from("2026-08-21T12:07:00Z")))
    ).toBe("2026-08-21T12:15:00.000Z");
  });

  test("a leap day is found years ahead", () => {
    expect(
      iso(nextRun(cron("0 0 29 2 *"), "UTC", from("2026-08-21T00:00:00Z")))
    ).toBe("2028-02-29T00:00:00.000Z");
  });

  test("both day fields restricted means either may match", () => {
    // The 13th, or any Friday - Vixie cron's rule. 1 September 2026 is a
    // Tuesday, so the first hit is Friday the 4th, not the 13th.
    expect(
      iso(nextRun(cron("0 0 13 * 5"), "UTC", from("2026-09-01T00:00:00Z")))
    ).toBe("2026-09-04T00:00:00.000Z");
  });

  test("cron honours the routine's zone and its transitions", () => {
    expect(
      iso(nextRun(cron("0 9 * * *"), NEW_YORK, from("2026-03-07T15:00:00Z")))
    ).toBe("2026-03-08T13:00:00.000Z");
  });

  test("an expression it cannot parse never fires", () => {
    expect(nextRun(cron("0 9 * *"), "UTC", from("2026-08-21T00:00:00Z"))).toBe(
      null
    );
    expect(
      nextRun(cron("0 9 * * MON"), "UTC", from("2026-08-21T00:00:00Z"))
    ).toBeNull();
  });
});

describe("an unknown time zone", () => {
  test("stops the routine rather than throwing inside an alarm", () => {
    expect(
      nextRun(daily("09:00"), "Mars/Olympus", from("2026-08-21T00:00:00Z"))
    ).toBeNull();
  });
});

describe("parseSchedule", () => {
  const reason = (value: unknown): string | null => {
    const parsed = parseSchedule(value);
    return parsed.ok ? null : parsed.reason;
  };

  test("accepts each shape of the union", () => {
    const shapes: unknown[] = [
      { at: "2026-08-21T09:00", type: "once" },
      { time: "09:00", type: "daily", weekdaysOnly: true },
      { day: 3, time: "23:59", type: "weekly" },
      { everyMinutes: MIN_INTERVAL_MINUTES, type: "interval" },
      { expr: "0 9 * * 1-5", type: "cron" },
    ];
    expect(shapes.map((shape) => parseSchedule(shape).ok)).toEqual(
      shapes.map(() => true)
    );
  });

  test("refuses an interval under fifteen minutes", () => {
    expect(reason({ everyMinutes: 14, type: "interval" })).toContain("15");
    expect(reason({ everyMinutes: 20.5, type: "interval" })).toContain("15");
  });

  test("refuses malformed times, dates, days and expressions", () => {
    expect(reason({ time: "9am", type: "daily" })).toContain('"time"');
    expect(reason({ time: "24:00", type: "daily" })).toContain('"time"');
    expect(reason({ at: "2026-02-31T09:00", type: "once" })).toContain('"at"');
    expect(reason({ at: "2026-08-21", type: "once" })).toContain('"at"');
    expect(reason({ day: 7, time: "09:00", type: "weekly" })).toContain(
      '"day"'
    );
    expect(reason({ expr: "* * * *", type: "cron" })).toContain('"expr"');
    expect(reason({ type: "hourly" })).toContain('"schedule.type"');
    expect(reason("daily")).toContain('"schedule"');
  });
});
