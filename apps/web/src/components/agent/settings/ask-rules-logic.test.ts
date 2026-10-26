import { describe, expect, test } from "bun:test";
import {
  BUILTIN_TOOL_KEYS,
  toolKeyOfInput,
  toolKeySuggestions,
} from "./ask-rules-logic";

describe("toolKeySuggestions", () => {
  test("offers the built-ins alone for an agent without connectors", () => {
    expect(toolKeySuggestions({ connectors: [], taken: [] })).toEqual(
      BUILTIN_TOOL_KEYS
    );
  });

  test("adds each connector tool under the server key of the connector", () => {
    const suggestions = toolKeySuggestions({
      connectors: [
        { name: "GitHub Tools", tools: [{ name: "create_issue" }] },
        { name: "github tools", tools: [{ name: "search" }] },
      ],
      taken: [],
    });
    expect(suggestions).toEqual([
      ...BUILTIN_TOOL_KEYS,
      "github-tools/create_issue",
      "github-tools-2/search",
    ]);
  });

  test("leaves out keys that already have a rule", () => {
    const suggestions = toolKeySuggestions({
      connectors: [{ name: "Docs", tools: [{ name: "read" }] }],
      taken: ["bash", "docs/read"],
    });
    expect(suggestions).toEqual(["write", "edit", "web_fetch"]);
  });
});

describe("toolKeyOfInput", () => {
  test("trims a key and refuses empty or spaced input", () => {
    expect(toolKeyOfInput("  bash ")).toBe("bash");
    expect(toolKeyOfInput("docs/read")).toBe("docs/read");
    expect(toolKeyOfInput("   ")).toBeNull();
    expect(toolKeyOfInput("two words")).toBeNull();
  });
});
