import { describe, expect, test } from "bun:test";
import {
  CLOUD_DEFAULT_MODEL,
  CLOUD_MODELS,
  cloudModelError,
  cloudModelFor,
} from "./models.ts";

describe("cloudModelFor", () => {
  test.each(CLOUD_MODELS.map((entry) => [entry.alias, entry.id] as const))(
    "resolves the alias %s to %s",
    (alias, id) => {
      expect(cloudModelFor(alias)).toBe(id);
    }
  );

  test.each(CLOUD_MODELS.map((entry) => [entry.id] as const))(
    "leaves the catalog id %s as it is",
    (id) => {
      expect(cloudModelFor(id)).toBe(id);
    }
  );

  test("ignores case and surrounding spaces", () => {
    expect(cloudModelFor("  Sonnet ")).toBe("claude-sonnet-5-5");
    expect(cloudModelFor("\tCLAUDE-HAIKU-5-5\n")).toBe("claude-haiku-5-5");
  });

  test("returns an unknown value trimmed but otherwise unchanged", () => {
    expect(cloudModelFor("  Claude-Typo-9  ")).toBe("Claude-Typo-9");
    expect(cloudModelFor("gpt-4o")).toBe("gpt-4o");
  });

  test("the default model is in the catalog", () => {
    expect(CLOUD_MODELS.some((entry) => entry.id === CLOUD_DEFAULT_MODEL)).toBe(
      true
    );
  });
});

describe("cloudModelError", () => {
  test.each(CLOUD_MODELS.map((entry) => [entry.alias] as const))(
    "accepts the alias %s",
    (alias) => {
      expect(cloudModelError(alias)).toBeUndefined();
    }
  );

  test.each(CLOUD_MODELS.map((entry) => [entry.id] as const))(
    "accepts the catalog id %s",
    (id) => {
      expect(cloudModelError(id)).toBeUndefined();
    }
  );

  test("ignores case and surrounding spaces", () => {
    expect(cloudModelError("  OPUS ")).toBeUndefined();
    expect(cloudModelError("\tClaude-Haiku-5-5\n")).toBeUndefined();
  });

  test("names the valid models for an unknown id", () => {
    expect(cloudModelError("claude-nope-1")).toBe(
      'Unknown model "claude-nope-1". Valid cloud models: opus (claude-opus-5-5), sonnet (claude-sonnet-5-5), haiku (claude-haiku-5-5).'
    );
  });

  test("treats an empty string as unknown", () => {
    expect(cloudModelError("")).toBe(
      'Unknown model "". Valid cloud models: opus (claude-opus-5-5), sonnet (claude-sonnet-5-5), haiku (claude-haiku-5-5).'
    );
  });
});
