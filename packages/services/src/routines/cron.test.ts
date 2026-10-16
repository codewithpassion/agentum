import { describe, expect, test } from "bun:test";

import {
  datePartsInTz,
  isValidTimeZone,
  nextFireTime,
  parseCron,
  validateCron,
} from "./cron.ts";

const SYD = "Australia/Sydney";

const ms = (value: number | null): number => {
  if (value === null) {
    throw new Error("Expected a fire time");
  }
  return value;
};

function iso(value: number | null): string {
  return value === null ? "null" : new Date(value).toISOString();
}

describe("validateCron", () => {
  test("accepts valid expressions", () => {
    for (const e of [
      "0 8 * * *",
      "0 8 * * 1-5",
      "*/15 * * * *",
      "0 9 * * 1",
      "30 17 * * 5",
      "0 8,12,17 * * *",
      "0 */2 * * *",
      "5 4 * * 0,6",
    ]) {
      expect(validateCron(e)).toBeNull();
    }
  });

  test("rejects invalid expressions", () => {
    expect(validateCron("")).not.toBeNull();
    expect(validateCron("0 8 *")).not.toBeNull();
    expect(validateCron("0 8 * * * *")).not.toBeNull();
    expect(validateCron("60 8 * * *")).not.toBeNull();
    expect(validateCron("0 25 * * *")).not.toBeNull();
    expect(validateCron("0 8 32 * *")).not.toBeNull();
    expect(validateCron("0 8 * 13 *")).not.toBeNull();
    expect(validateCron("0 8 * * 7")).not.toBeNull();
  });
});

describe("parseCron", () => {
  const sorted = (values: Set<number>) => [...values].sort((a, b) => a - b);

  test("literal, step, range and list", () => {
    expect(sorted(parseCron("5 4 * * *").minute)).toEqual([5]);
    expect(sorted(parseCron("*/15 * * * *").minute)).toEqual([0, 15, 30, 45]);
    expect(sorted(parseCron("1-3 * * * *").minute)).toEqual([1, 2, 3]);
    expect(sorted(parseCron("0,15,30,45 * * * *").minute)).toEqual([
      0, 15, 30, 45,
    ]);
    expect(sorted(parseCron("1-10/3 * * * *").minute)).toEqual([1, 4, 7, 10]);
  });

  test("a stepped single value runs to the end of the range", () => {
    expect(sorted(parseCron("5/15 * * * *").minute)).toEqual([5, 20, 35, 50]);
  });

  test("rejects a bad field count, out-of-range values and a zero step", () => {
    expect(() => parseCron("* * *")).toThrow();
    expect(() => parseCron("60 * * * *")).toThrow();
    expect(() => parseCron("*/0 * * * *")).toThrow();
    expect(() => parseCron("a * * * *")).toThrow();
  });
});

describe("isValidTimeZone", () => {
  test("accepts IANA zones, rejects junk", () => {
    expect(isValidTimeZone("Australia/Sydney")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
  });
});

describe("nextFireTime", () => {
  test("daily at 8am fires later the same day", () => {
    const next = nextFireTime(
      "0 8 * * *",
      SYD,
      new Date("2025-06-15T06:00:00+10:00")
    );
    expect(iso(next)).toBe("2025-06-14T22:00:00.000Z"); // 08:00 AEST
  });

  test("weekdays only skips the weekend", () => {
    const saturday = new Date("2025-06-14T09:00:00+10:00");
    const next = nextFireTime("0 8 * * 1-5", SYD, saturday);
    expect(iso(next)).toBe("2025-06-15T22:00:00.000Z"); // Mon 16 Jun 08:00 AEST
    expect(datePartsInTz(new Date(ms(next)), SYD).weekday).toBe(1);
  });

  test("every 15 minutes finds the next quarter hour", () => {
    const next = nextFireTime(
      "*/15 * * * *",
      SYD,
      new Date("2025-06-15T10:03:00+10:00")
    );
    expect(iso(next)).toBe("2025-06-15T00:15:00.000Z");
  });

  test("result is strictly after `after`, even on an exact match", () => {
    const at = new Date("2025-06-15T10:15:00+10:00");
    const next = nextFireTime("*/15 * * * *", SYD, at);
    expect(iso(next)).toBe("2025-06-15T00:30:00.000Z");
  });

  test("step and list values", () => {
    const step = nextFireTime(
      "0 */6 * * *",
      SYD,
      new Date("2025-06-15T00:00:00+10:00")
    );
    expect(datePartsInTz(new Date(ms(step)), SYD).hour).toBe(6);
    const list = nextFireTime(
      "0 8,12,17 * * *",
      SYD,
      new Date("2025-06-15T13:00:00+10:00")
    );
    expect(datePartsInTz(new Date(ms(list)), SYD).hour).toBe(17);
  });

  test("respects the given timezone", () => {
    const next = nextFireTime(
      "0 9 * * *",
      "America/New_York",
      new Date("2025-06-15T00:00:00Z")
    );
    expect(iso(next)).toBe("2025-06-15T13:00:00.000Z"); // 09:00 EDT
  });

  test("returns null for an expression that never matches", () => {
    expect(
      nextFireTime("0 0 31 2 *", SYD, new Date("2025-06-15T00:00:00Z"))
    ).toBeNull();
  });

  test("throws on an unknown timezone", () => {
    expect(() => nextFireTime("0 9 * * *", "Mars/Olympus")).toThrow();
  });

  describe("DST (Australia/Sydney 2025: fall back Apr 6, spring forward Oct 5)", () => {
    test("consecutive daily fires are 23h apart across spring-forward", () => {
      const first = nextFireTime(
        "0 9 * * *",
        SYD,
        new Date("2025-10-04T00:00:00+10:00")
      );
      expect(iso(first)).toBe("2025-10-03T23:00:00.000Z"); // Sat 09:00 AEST
      const second = nextFireTime("0 9 * * *", SYD, new Date(ms(first)));
      expect(iso(second)).toBe("2025-10-04T22:00:00.000Z"); // Sun 09:00 AEDT
      expect(ms(second) - ms(first)).toBe(23 * 3_600_000);
    });

    test("consecutive daily fires are 25h apart across fall-back", () => {
      const first = nextFireTime(
        "0 9 * * *",
        SYD,
        new Date("2025-04-05T00:00:00+11:00")
      );
      expect(iso(first)).toBe("2025-04-04T22:00:00.000Z"); // Sat 09:00 AEDT
      const second = nextFireTime("0 9 * * *", SYD, new Date(ms(first)));
      expect(iso(second)).toBe("2025-04-05T23:00:00.000Z"); // Sun 09:00 AEST
      expect(ms(second) - ms(first)).toBe(25 * 3_600_000);
    });

    test("day skip from a 23-hour day does not swallow the next day's first hour", () => {
      // Sunday 5 Oct is 23h long. A Monday 00:30 job must land on Mon 6 Oct,
      // not overshoot to the following week.
      const next = nextFireTime(
        "30 0 * * 1",
        SYD,
        new Date("2025-10-05T01:00:00+10:00")
      );
      expect(iso(next)).toBe("2025-10-05T13:30:00.000Z"); // Mon 00:30 AEDT
    });

    test("midnight job after a 25-hour day lands at 00:00 local", () => {
      const next = nextFireTime(
        "0 0 * * *",
        SYD,
        new Date("2025-04-06T12:00:00+10:00")
      );
      expect(iso(next)).toBe("2025-04-06T14:00:00.000Z"); // Mon 7 Apr 00:00 AEST
    });

    // Changed from the upstream copy, which skipped the day.
    test("a local time inside the spring-forward gap fires once, when the gap ends", () => {
      // 02:30 does not exist on Sun 5 Oct 2025; the clock jumps 02:00 to 03:00.
      const first = nextFireTime(
        "30 2 * * *",
        SYD,
        new Date("2025-10-05T00:00:00+10:00")
      );
      expect(iso(first)).toBe("2025-10-04T16:00:00.000Z"); // Sun 03:00 AEDT
      const second = nextFireTime("30 2 * * *", SYD, new Date(ms(first)));
      expect(iso(second)).toBe("2025-10-05T15:30:00.000Z"); // Mon 02:30 AEDT
    });

    test("a gap job that also matches 03:00 fires once at the end of the gap", () => {
      const first = nextFireTime(
        "0 2,3 * * *",
        SYD,
        new Date("2025-10-05T00:00:00+10:00")
      );
      expect(iso(first)).toBe("2025-10-04T16:00:00.000Z");
      const second = nextFireTime("0 2,3 * * *", SYD, new Date(ms(first)));
      expect(iso(second)).toBe("2025-10-05T15:00:00.000Z"); // Mon 02:00 AEDT
    });

    test("an hourly job keeps real time across the gap", () => {
      // 01:30 AEST, then 03:30 AEDT: one hour of real time, no extra fire.
      const next = nextFireTime(
        "30 * * * *",
        SYD,
        new Date("2025-10-04T15:30:00Z")
      );
      expect(iso(next)).toBe("2025-10-04T16:30:00.000Z");
    });

    test("a job in the repeated fall-back hour fires once, in the first pass", () => {
      // 02:30 happens at 15:30Z (AEDT) and again at 16:30Z (AEST) on 6 Apr.
      const first = nextFireTime(
        "30 2 * * *",
        SYD,
        new Date("2025-04-06T00:00:00+11:00")
      );
      expect(iso(first)).toBe("2025-04-05T15:30:00.000Z");
      const second = nextFireTime("30 2 * * *", SYD, new Date(ms(first)));
      expect(iso(second)).toBe("2025-04-06T16:30:00.000Z"); // Mon 7 Apr 02:30 AEST
    });

    test("a job on every hour fires in both passes of the repeated hour", () => {
      const first = nextFireTime(
        "30 * * * *",
        SYD,
        new Date("2025-04-05T15:00:00Z")
      );
      expect(iso(first)).toBe("2025-04-05T15:30:00.000Z");
      const second = nextFireTime("30 * * * *", SYD, new Date(ms(first)));
      expect(iso(second)).toBe("2025-04-05T16:30:00.000Z");
    });
  });
});
