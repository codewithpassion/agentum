import { describe, expect, test } from "bun:test";
import { describeCron } from "./describe-cron";
import { compilePreset, PRESET_KINDS, type Preset } from "./presets";

describe("describeCron", () => {
  test("describes every minute", () => {
    expect(describeCron("* * * * *", "UTC")).toBe("every minute");
  });

  test("describes a minute step", () => {
    expect(describeCron("*/5 * * * *", "UTC")).toBe("every 5 minutes");
  });

  test("describes an hourly run with a two-digit minute", () => {
    expect(describeCron("5 * * * *", "UTC")).toBe("every hour at :05");
    expect(describeCron("0 * * * *", "UTC")).toBe("every hour at :00");
  });

  test("describes a daily run at a zero-padded time", () => {
    expect(describeCron("0 9 * * *", "UTC")).toBe("every day at 09:00 UTC");
  });

  test("describes weekdays", () => {
    expect(describeCron("30 9 * * 1-5", "UTC")).toBe("weekdays at 09:30 UTC");
  });

  test("describes a weekly run on Sunday and Saturday", () => {
    expect(describeCron("0 9 * * 0", "UTC")).toBe("every Sunday at 09:00 UTC");
    expect(describeCron("0 9 * * 6", "UTC")).toBe(
      "every Saturday at 09:00 UTC"
    );
  });

  test("describes a monthly run", () => {
    expect(describeCron("15 14 3 * *", "UTC")).toBe(
      "monthly on day 3 at 14:15 UTC"
    );
  });

  test("uses the timezone passed in", () => {
    expect(describeCron("0 9 * * *", "Europe/Zurich")).toBe(
      "every day at 09:00 Europe/Zurich"
    );
  });

  test.each([
    "0 9 * * 1,3",
    "0 25 * * *",
    "*/0 * * * *",
    "*/1 * * * *",
    "*/60 * * * *",
    "60 * * * *",
    "0 9 32 * *",
    "0 9 * * 7",
    "0 9 * 1 *",
    "0 9 * * 1-4",
    "0 9 L * *",
    "@daily",
    "not cron",
    "",
  ])("returns the raw cron for %p", (cron) => {
    expect(describeCron(cron, "UTC")).toBe(cron);
  });

  test("describes every preset kind compiled by compilePreset", () => {
    const presets: readonly Preset[] = [
      { kind: "everyMinutes", minutes: 5 },
      { kind: "hourly", minute: 5 },
      { hour: 9, kind: "daily", minute: 0 },
      { hour: 9, kind: "weekdays", minute: 30 },
      { hour: 9, kind: "weekly", minute: 0, weekday: 0 },
      { day: 1, hour: 9, kind: "monthly", minute: 0 },
    ];
    expect(presets.map((preset) => preset.kind).sort()).toEqual(
      [...PRESET_KINDS].sort()
    );
    for (const preset of presets) {
      const cron = compilePreset(preset);
      expect(describeCron(cron, "UTC")).not.toBe(cron);
    }
  });
});
