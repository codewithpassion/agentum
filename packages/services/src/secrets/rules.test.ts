import { describe, expect, test } from "bun:test";
import {
  matchHost,
  normalizeHost,
  renderHeader,
  ruleSchema,
  rulesSchema,
} from "./rules.ts";

describe("matchHost", () => {
  test("an exact pattern matches that host only", () => {
    expect(matchHost("api.openai.com", "api.openai.com")).toBe(true);
    expect(matchHost("api.openai.com", "API.OpenAI.com")).toBe(true);
    expect(matchHost("api.openai.com", "api.openai.com.")).toBe(true);
    expect(matchHost("api.openai.com", "openai.com")).toBe(false);
    expect(matchHost("api.openai.com", "evil-api.openai.com")).toBe(false);
    expect(matchHost("api.openai.com", "api.openai.com.evil.com")).toBe(false);
  });

  test("a wildcard matches subdomains at any depth and not the domain itself", () => {
    expect(matchHost("*.example.com", "api.example.com")).toBe(true);
    expect(matchHost("*.example.com", "a.b.example.com")).toBe(true);
    expect(matchHost("*.example.com", "example.com")).toBe(false);
    expect(matchHost("*.example.com", "badexample.com")).toBe(false);
    expect(matchHost("*.example.com", ".example.com")).toBe(false);
    expect(matchHost("*.example.com", "example.com.evil.com")).toBe(false);
  });

  test("normalizeHost lowercases and drops a trailing dot", () => {
    expect(normalizeHost("API.Example.COM.")).toBe("api.example.com");
  });
});

describe("rule validation", () => {
  const rule = {
    header: "Authorization",
    host: "api.openai.com",
    template: "Bearer {value}",
  };

  test("a good rule parses, and the host is lowercased", () => {
    expect(ruleSchema.parse({ ...rule, host: "API.OpenAI.com" }).host).toBe(
      "api.openai.com"
    );
  });

  test.each([
    ["a bare word", { host: "localhost" }],
    ["a scheme", { host: "https://api.openai.com" }],
    ["a port", { host: "api.openai.com:443" }],
    ["a path", { host: "api.openai.com/v1" }],
    ["a top-level wildcard", { host: "*.com" }],
    ["a bare star", { host: "*" }],
    ["a mid-host star", { host: "api.*.com" }],
    ["a header Host", { header: "Host" }],
    ["a header with a colon", { header: "X:Y" }],
    ["a template without {value}", { template: "Bearer" }],
    ["a template with a newline", { template: "Bearer {value}\nX: y" }],
  ])("refuses %s", (_label, change) => {
    expect(ruleSchema.safeParse({ ...rule, ...change }).success).toBe(false);
  });

  test("a secret holds one to eight rules", () => {
    expect(rulesSchema.safeParse([]).success).toBe(false);
    expect(rulesSchema.safeParse(new Array(9).fill(rule)).success).toBe(false);
    expect(rulesSchema.safeParse(new Array(8).fill(rule)).success).toBe(true);
  });

  test("renderHeader puts the value in the template, even a value with $ patterns", () => {
    expect(renderHeader(ruleSchema.parse(rule), "abc$&def")).toBe(
      "Bearer abc$&def"
    );
    expect(
      renderHeader(
        ruleSchema.parse({ ...rule, header: "x-api-key", template: "{value}" }),
        "k-12345678"
      )
    ).toBe("k-12345678");
  });
});
