import { describe, expect, test } from "bun:test";
import {
  CLOUD_DEFAULT_MODEL,
  CLOUD_MODELS,
  CLOUD_PROVIDER_LABELS,
  cloudModelError,
  cloudModelFor,
  cloudModelRef,
  isAnthropicModel,
  parseModelRef,
} from "./models.ts";

const ALIASED = CLOUD_MODELS.filter((entry) => entry.alias !== undefined);
const OPEN_REFS = [
  "openrouter:z-ai/glm-5.3",
  "openrouter:z-ai/glm-5.3-flash",
  "openrouter:deepseek/deepseek-v4.1-flash",
] as const;

describe("cloudModelFor", () => {
  test.each(ALIASED.map((entry) => [entry.alias, entry.id] as const))(
    "resolves the alias %s to %s",
    (alias, id) => {
      expect(cloudModelFor(alias ?? "")).toBe(id);
    }
  );

  test.each(CLOUD_MODELS.map((entry) => [cloudModelRef(entry)] as const))(
    "leaves the catalog ref %s as it is",
    (ref) => {
      expect(cloudModelFor(ref)).toBe(ref);
    }
  );

  test.each(OPEN_REFS.map((ref) => [ref] as const))(
    "resolves the OpenRouter ref %s to itself",
    (ref) => {
      expect(cloudModelFor(ref)).toBe(ref);
      expect(cloudModelFor(ref.toUpperCase())).toBe(ref);
      expect(cloudModelFor(`  ${ref}  `)).toBe(ref);
    }
  );

  test("ignores case and surrounding spaces", () => {
    expect(cloudModelFor("  Sonnet ")).toBe("claude-sonnet-5-5");
    expect(cloudModelFor("\tCLAUDE-HAIKU-5-5\n")).toBe("claude-haiku-5-5");
  });

  test("returns an unknown value trimmed but otherwise unchanged", () => {
    expect(cloudModelFor("  Claude-Typo-9  ")).toBe("Claude-Typo-9");
    expect(cloudModelFor("gpt-4o")).toBe("gpt-4o");
    expect(cloudModelFor("openrouter:nope/model")).toBe(
      "openrouter:nope/model"
    );
  });

  test("the default model is in the catalog", () => {
    expect(CLOUD_MODELS.some((entry) => entry.id === CLOUD_DEFAULT_MODEL)).toBe(
      true
    );
  });
});

describe("cloudModelError", () => {
  test.each(ALIASED.map((entry) => [entry.alias] as const))(
    "accepts the alias %s",
    (alias) => {
      expect(cloudModelError(alias ?? "")).toBeUndefined();
    }
  );

  test.each(CLOUD_MODELS.map((entry) => [cloudModelRef(entry)] as const))(
    "accepts the catalog ref %s",
    (ref) => {
      expect(cloudModelError(ref)).toBeUndefined();
    }
  );

  test.each(OPEN_REFS.map((ref) => [ref] as const))(
    "accepts the OpenRouter ref %s, also upper-cased and padded",
    (ref) => {
      expect(cloudModelError(ref)).toBeUndefined();
      expect(cloudModelError(ref.toUpperCase())).toBeUndefined();
      expect(cloudModelError(`  ${ref.toUpperCase()}  `)).toBeUndefined();
    }
  );

  test("ignores case and surrounding spaces", () => {
    expect(cloudModelError("  OPUS ")).toBeUndefined();
    expect(cloudModelError("\tClaude-Haiku-5-5\n")).toBeUndefined();
  });

  test("rejects an unknown OpenRouter model", () => {
    expect(cloudModelError("openrouter:nope/model")).toBe(
      'Unknown model "openrouter:nope/model". Valid cloud models: opus (claude-opus-5-5), sonnet (claude-sonnet-5-5), haiku (claude-haiku-5-5), openrouter:z-ai/glm-5.3, openrouter:z-ai/glm-5.3-flash, openrouter:deepseek/deepseek-v4.1-flash.'
    );
  });

  test("rejects a bare OpenRouter id with no prefix", () => {
    expect(cloudModelError("z-ai/glm-5.3")).toBe(
      'Unknown model "z-ai/glm-5.3". Valid cloud models: opus (claude-opus-5-5), sonnet (claude-sonnet-5-5), haiku (claude-haiku-5-5), openrouter:z-ai/glm-5.3, openrouter:z-ai/glm-5.3-flash, openrouter:deepseek/deepseek-v4.1-flash.'
    );
  });

  test("names the valid models for an unknown id", () => {
    expect(cloudModelError("claude-nope-1")).toBe(
      'Unknown model "claude-nope-1". Valid cloud models: opus (claude-opus-5-5), sonnet (claude-sonnet-5-5), haiku (claude-haiku-5-5), openrouter:z-ai/glm-5.3, openrouter:z-ai/glm-5.3-flash, openrouter:deepseek/deepseek-v4.1-flash.'
    );
  });

  test("treats an empty string as unknown", () => {
    expect(cloudModelError("")).toBe(
      'Unknown model "". Valid cloud models: opus (claude-opus-5-5), sonnet (claude-sonnet-5-5), haiku (claude-haiku-5-5), openrouter:z-ai/glm-5.3, openrouter:z-ai/glm-5.3-flash, openrouter:deepseek/deepseek-v4.1-flash.'
    );
  });

  test("does not offer the dated DeepSeek id", () => {
    expect(cloudModelError("deepseek/deepseek-v4.1-flash-1017")).toBeDefined();
    expect(
      cloudModelError("openrouter:deepseek/deepseek-v4.1-flash-1017")
    ).toBeDefined();
  });
});

describe("parseModelRef", () => {
  test("reads a bare alias as Anthropic", () => {
    expect(parseModelRef("sonnet")).toEqual({
      id: "sonnet",
      provider: "anthropic",
    });
  });

  test("reads a bare Anthropic id as Anthropic", () => {
    expect(parseModelRef("claude-haiku-5-5")).toEqual({
      id: "claude-haiku-5-5",
      provider: "anthropic",
    });
  });

  test("splits an OpenRouter ref at its first colon", () => {
    expect(parseModelRef("openrouter:z-ai/glm-5.3")).toEqual({
      id: "z-ai/glm-5.3",
      provider: "openrouter",
    });
  });

  test("keeps the case of the id and matches the provider in any case", () => {
    expect(parseModelRef("OpenRouter:Z-AI/GLM-5.3")).toEqual({
      id: "Z-AI/GLM-5.3",
      provider: "openrouter",
    });
  });

  test("keeps a colon inside the id", () => {
    expect(parseModelRef("openrouter:vendor/model:free")).toEqual({
      id: "vendor/model:free",
      provider: "openrouter",
    });
  });

  test("treats an unknown prefix as Anthropic", () => {
    expect(parseModelRef("foo:bar")).toEqual({
      id: "foo:bar",
      provider: "anthropic",
    });
  });

  test("treats a Bedrock id with a colon as Anthropic", () => {
    expect(parseModelRef("us.anthropic.claude-x-v1:0")).toEqual({
      id: "us.anthropic.claude-x-v1:0",
      provider: "anthropic",
    });
  });

  test("trims surrounding spaces", () => {
    expect(parseModelRef("  openrouter:  z-ai/glm-5.3 \n")).toEqual({
      id: "z-ai/glm-5.3",
      provider: "openrouter",
    });
    expect(parseModelRef("  sonnet  ")).toEqual({
      id: "sonnet",
      provider: "anthropic",
    });
  });
});

describe("isAnthropicModel", () => {
  test("is true for aliases and Anthropic ids", () => {
    expect(isAnthropicModel("opus")).toBe(true);
    expect(isAnthropicModel("claude-sonnet-5-5")).toBe(true);
    expect(isAnthropicModel("us.anthropic.claude-x-v1:0")).toBe(true);
  });

  test("is false for an OpenRouter ref", () => {
    expect(isAnthropicModel("openrouter:z-ai/glm-5.3")).toBe(false);
    expect(isAnthropicModel("  OpenRouter:Z-AI/GLM-5.3  ")).toBe(false);
  });
});

describe("catalogue", () => {
  test("every entry has a label, a description and text input", () => {
    for (const entry of CLOUD_MODELS) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.input).toContain("text");
    }
  });

  test("every non-Anthropic provider has a label", () => {
    for (const entry of CLOUD_MODELS) {
      if (entry.provider !== "anthropic") {
        expect(Object.keys(CLOUD_PROVIDER_LABELS)).toContain(entry.provider);
      }
    }
  });

  test("refs are unique", () => {
    const refs = CLOUD_MODELS.map((entry) => cloudModelRef(entry));
    expect(new Set(refs).size).toBe(refs.length);
  });
});
