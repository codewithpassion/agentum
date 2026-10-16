import { describe, expect, test } from "bun:test";
import { validateCron } from "@repo/services/routines/cron";
import {
  compilePreset,
  PRESET_KINDS,
  PRESET_LABELS,
  type Preset,
} from "./presets";

const VALID_PRESETS: readonly Preset[] = [
  { kind: "everyMinutes", minutes: 1 },
  { kind: "everyMinutes", minutes: 5 },
  { kind: "everyMinutes", minutes: 59 },
  { kind: "hourly", minute: 0 },
  { kind: "hourly", minute: 59 },
  { hour: 0, kind: "daily", minute: 0 },
  { hour: 23, kind: "daily", minute: 59 },
  { hour: 9, kind: "weekdays", minute: 30 },
  { hour: 8, kind: "weekly", minute: 0, weekday: 0 },
  { hour: 23, kind: "weekly", minute: 59, weekday: 6 },
  { day: 1, hour: 12, kind: "monthly", minute: 0 },
  { day: 28, hour: 6, kind: "monthly", minute: 45 },
];

describe("PRESET_KINDS and PRESET_LABELS", () => {
  test("lists every kind in order with a label", () => {
    expect(PRESET_KINDS).toEqual([
      "everyMinutes",
      "hourly",
      "daily",
      "weekdays",
      "weekly",
      "monthly",
    ]);
    for (const kind of PRESET_KINDS) {
      expect(PRESET_LABELS[kind].length).toBeGreaterThan(0);
    }
  });
});

describe("compilePreset", () => {
  test("everyMinutes with 1 runs every minute", () => {
    expect(compilePreset({ kind: "everyMinutes", minutes: 1 })).toBe(
      "* * * * *"
    );
  });

  test("everyMinutes with N uses a step", () => {
    expect(compilePreset({ kind: "everyMinutes", minutes: 15 })).toBe(
      "*/15 * * * *"
    );
  });

  test("hourly", () => {
    expect(compilePreset({ kind: "hourly", minute: 30 })).toBe("30 * * * *");
  });

  test("daily", () => {
    expect(compilePreset({ hour: 9, kind: "daily", minute: 5 })).toBe(
      "5 9 * * *"
    );
  });

  test("weekdays", () => {
    expect(compilePreset({ hour: 17, kind: "weekdays", minute: 0 })).toBe(
      "0 17 * * 1-5"
    );
  });

  test("weekly, with 0 as Sunday", () => {
    expect(
      compilePreset({ hour: 8, kind: "weekly", minute: 15, weekday: 0 })
    ).toBe("15 8 * * 0");
  });

  test("weekly, with 6 as Saturday", () => {
    expect(
      compilePreset({ hour: 8, kind: "weekly", minute: 15, weekday: 6 })
    ).toBe("15 8 * * 6");
  });

  test("monthly", () => {
    expect(
      compilePreset({ day: 14, hour: 7, kind: "monthly", minute: 45 })
    ).toBe("45 7 14 * *");
  });

  test("every valid preset compiles to a cron that validateCron accepts", () => {
    for (const preset of VALID_PRESETS) {
      expect(validateCron(compilePreset(preset))).toBeNull();
    }
  });

  const RANGE_CASES: readonly [string, Preset][] = [
    ["minutes", { kind: "everyMinutes", minutes: 0 }],
    ["minutes", { kind: "everyMinutes", minutes: 60 }],
    ["minutes", { kind: "everyMinutes", minutes: 1.5 }],
    ["minute", { kind: "hourly", minute: 60 }],
    ["minute", { kind: "hourly", minute: -1 }],
    ["minute", { kind: "hourly", minute: 0.5 }],
    ["minute", { hour: 9, kind: "daily", minute: 60 }],
    ["hour", { hour: 24, kind: "daily", minute: 0 }],
    ["hour", { hour: Number.NaN, kind: "daily", minute: 0 }],
    ["hour", { hour: 24, kind: "weekdays", minute: 0 }],
    ["hour", { hour: 9.25, kind: "weekdays", minute: 0 }],
    ["weekday", { hour: 8, kind: "weekly", minute: 0, weekday: 7 }],
    ["weekday", { hour: 8, kind: "weekly", minute: 0, weekday: -1 }],
    ["day", { day: 29, hour: 8, kind: "monthly", minute: 0 }],
    ["day", { day: 0, hour: 8, kind: "monthly", minute: 0 }],
    ["day", { day: 1.5, hour: 8, kind: "monthly", minute: 0 }],
  ];

  for (const [field, preset] of RANGE_CASES) {
    test(`throws a RangeError naming ${field} for ${JSON.stringify(preset)}`, () => {
      expect(() => compilePreset(preset)).toThrow(RangeError);
      expect(() => compilePreset(preset)).toThrow(`${field} must be`);
    });
  }
});
