import { describe, expect, test } from "bun:test";
import { AGENT_MODEL, AVAILABLE_MODELS } from "#/modules/anthropic/config";
import { modelLabel, WORKSPACE_DEFAULT_MODEL_LABEL } from "./model-format";

describe("modelLabel", () => {
  test("names every model the catalog offers", () => {
    for (const model of AVAILABLE_MODELS) {
      expect(modelLabel(model.id)).toBe(model.label);
    }
  });

  test("shows an id the catalog no longer offers as itself", () => {
    expect(modelLabel("claude-retired-3")).toBe("claude-retired-3");
  });
});

test("the workspace default is named after the default model", () => {
  expect(WORKSPACE_DEFAULT_MODEL_LABEL).toBe(
    `Workspace default (${modelLabel(AGENT_MODEL)})`
  );
  expect(WORKSPACE_DEFAULT_MODEL_LABEL).toContain("Sonnet 5");
});
