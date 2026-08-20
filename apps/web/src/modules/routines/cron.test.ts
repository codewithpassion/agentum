import { describe, expect, test } from "bun:test";
import { cronMatchesDay, parseCron } from "./cron";

/** The five-field subset: what it accepts, and what it refuses to guess at. */

describe("parseCron", () => {
  test("expands stars, numbers, ranges, steps and lists", () => {
    const fields = parseCron("0,30 9-17/4 * * *");
    expect(fields?.minutes).toEqual([0, 30]);
    expect(fields?.hours).toEqual([9, 13, 17]);
    expect(fields?.daysOfMonth).toHaveLength(31);
    expect(fields?.months).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  test("a star with a step covers the whole field", () => {
    expect(parseCron("*/20 * * * *")?.minutes).toEqual([0, 20, 40]);
  });

  test("day 7 is Sunday, same as day 0", () => {
    expect(parseCron("0 0 * * 7")?.daysOfWeek).toEqual([0]);
    expect(parseCron("0 0 * * 0,7")?.daysOfWeek).toEqual([0]);
  });

  test("extra whitespace between fields is fine", () => {
    expect(parseCron("  0   9  *  *  1  ")?.hours).toEqual([9]);
  });

  test("refuses what it does not implement, rather than guessing", () => {
    const rejected = [
      "0 9 * *", // four fields
      "0 9 * * * *", // six
      "0 9 * * MON", // names
      "@daily", // macros
      "0 9 ? * *", // quartz wildcards
      "0 9 L * *",
      "0 9 * * 5#2",
      "60 9 * * *", // out of range
      "0 24 * * *",
      "0 9 0 * *",
      "0 9 * 13 *",
      "0 9 * * 8",
      "5/10 9 * * *", // step from a single value
      "0 9 5-1 * *", // inverted range
      "*/0 9 * * *", // zero step
      "", // nothing at all
    ];
    expect(rejected.map((expr) => parseCron(expr))).toEqual(
      rejected.map(() => null)
    );
  });
});

describe("cronMatchesDay", () => {
  const fields = (expr: string) => {
    const parsed = parseCron(expr);
    if (!parsed) {
      throw new Error(`Could not parse "${expr}".`);
    }
    return parsed;
  };

  test("both day fields restricted means either may match", () => {
    const friday13th = fields("0 0 13 * 5");
    // The 13th, on a Wednesday.
    expect(
      cronMatchesDay(friday13th, { day: 13, month: 5, weekday: 3 })
    ).toBeTrue();
    // A Friday that is not the 13th.
    expect(
      cronMatchesDay(friday13th, { day: 8, month: 5, weekday: 5 })
    ).toBeTrue();
    expect(
      cronMatchesDay(friday13th, { day: 8, month: 5, weekday: 2 })
    ).toBeFalse();
  });

  test("one restricted day field is an ordinary AND", () => {
    const firstOfMonth = fields("0 0 1 * *");
    expect(
      cronMatchesDay(firstOfMonth, { day: 1, month: 7, weekday: 4 })
    ).toBeTrue();
    expect(
      cronMatchesDay(firstOfMonth, { day: 2, month: 7, weekday: 5 })
    ).toBeFalse();
  });

  test("the month field gates everything else", () => {
    const february = fields("0 0 * 2 *");
    expect(
      cronMatchesDay(february, { day: 14, month: 2, weekday: 6 })
    ).toBeTrue();
    expect(
      cronMatchesDay(february, { day: 14, month: 3, weekday: 6 })
    ).toBeFalse();
  });
});
