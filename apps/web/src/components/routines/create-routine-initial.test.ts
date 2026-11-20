import { describe, expect, test } from "bun:test";
import {
  initialRoutineState,
  type RoutineInitial,
} from "./create-routine-initial";

const DRAFT: RoutineInitial = {
  cron: "0 9 * * 1-5",
  name: "Morning digest",
  prompt: "Summarise yesterday's signups.",
  timezone: "Europe/Zurich",
};

describe("initialRoutineState", () => {
  test("starts empty on the daily preset when no draft is given", () => {
    expect(initialRoutineState(undefined)).toEqual({
      customCron: "",
      kind: "daily",
      name: "",
      prompt: "",
      timezone: "",
    });
  });

  test("prefills the draft and switches to the custom cron kind", () => {
    expect(initialRoutineState(DRAFT)).toEqual({
      customCron: "0 9 * * 1-5",
      kind: "custom",
      name: "Morning digest",
      prompt: "Summarise yesterday's signups.",
      timezone: "Europe/Zurich",
    });
  });

  test("keeps an empty timezone from the draft as an empty string", () => {
    expect(initialRoutineState({ ...DRAFT, timezone: "" }).timezone).toBe("");
  });
});
