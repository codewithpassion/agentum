import { describe, expect, test } from "bun:test";
import { CLOUD_DEFAULT_MODEL, CLOUD_MODELS, cloudModelFor } from "./models.ts";

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
