import { describe, expect, test } from "bun:test";
import {
  MAX_TURNS_DEFAULT,
  MAX_TURNS_KEY,
  MAX_TURNS_MAX,
  MAX_TURNS_MIN,
} from "@repo/protocol/safeguards";
import { CLOUD_ENVIRONMENT_KEY } from "@repo/services/cloud/environment";
import { maxTurnsInputOf, runtimeConfigOf } from "./agent-config.ts";

const cloud = {
  environment: "isolate",
  maxTurns: "",
  runtime: "cloud",
} as const;

describe("maxTurnsInputOf", () => {
  test("is empty when no turn limit is set", () => {
    expect(maxTurnsInputOf({})).toBe("");
    expect(maxTurnsInputOf({ [MAX_TURNS_KEY]: undefined })).toBe("");
  });

  test("returns a valid configured value as a string", () => {
    expect(maxTurnsInputOf({ [MAX_TURNS_KEY]: MAX_TURNS_MIN })).toBe(
      String(MAX_TURNS_MIN)
    );
    expect(maxTurnsInputOf({ [MAX_TURNS_KEY]: MAX_TURNS_MAX })).toBe(
      String(MAX_TURNS_MAX)
    );
    expect(maxTurnsInputOf({ [MAX_TURNS_KEY]: MAX_TURNS_DEFAULT })).toBe(
      String(MAX_TURNS_DEFAULT)
    );
  });

  test("is empty for an invalid configured value", () => {
    for (const value of [
      MAX_TURNS_MIN - 1,
      MAX_TURNS_MAX + 1,
      12.5,
      "50",
      null,
    ]) {
      expect(maxTurnsInputOf({ [MAX_TURNS_KEY]: value })).toBe("");
    }
  });
});

describe("runtimeConfigOf", () => {
  test("sets the turn limit for cloud and machine runtimes", () => {
    for (const runtime of ["cloud", "machine"] as const) {
      expect(
        runtimeConfigOf({}, { ...cloud, maxTurns: "250", runtime })
      ).toMatchObject({ [MAX_TURNS_KEY]: 250 });
    }
  });

  test("removes the turn limit when the input is empty or blank", () => {
    const base = { [MAX_TURNS_KEY]: 200, other: "kept" };
    expect(runtimeConfigOf(base, { ...cloud, maxTurns: "" })).toEqual({
      [CLOUD_ENVIRONMENT_KEY]: "isolate",
      other: "kept",
    });
    expect(
      runtimeConfigOf(base, { ...cloud, maxTurns: "   ", runtime: "machine" })
    ).toEqual({ other: "kept" });
  });

  test("keeps other keys and does not change the base", () => {
    const base = { other: "kept" };
    const result = runtimeConfigOf(base, { ...cloud, maxTurns: "20" });
    expect(result).toEqual({
      [CLOUD_ENVIRONMENT_KEY]: "isolate",
      [MAX_TURNS_KEY]: 20,
      other: "kept",
    });
    expect(base).toEqual({ other: "kept" });
  });

  test("sets the environment only for cloud", () => {
    const values = {
      environment: "linux-vm",
      maxTurns: "",
      runtime: "cloud",
    } as const;
    expect(runtimeConfigOf({}, values)).toEqual({
      [CLOUD_ENVIRONMENT_KEY]: "linux-vm",
    });
    expect(runtimeConfigOf({}, { ...values, runtime: "machine" })).toEqual({});
  });

  test("ignores the turn limit and the environment for managed", () => {
    const base = { [MAX_TURNS_KEY]: 200, environment: "isolate" };
    expect(
      runtimeConfigOf(base, {
        environment: "linux-vm",
        maxTurns: "30",
        runtime: "managed",
      })
    ).toEqual(base);
  });
});
