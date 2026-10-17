import { describe, expect, test } from "bun:test";
import {
  addRule,
  changeRule,
  emptyRule,
  hostsOf,
  MAX_RULES,
  type RuleDraft,
  removeRule,
  rulesReady,
  type SecretRecord,
  toRules,
} from "./secret-model.ts";

const rule = (id: string, overrides: Partial<RuleDraft> = {}): RuleDraft => ({
  header: "Authorization",
  host: "api.example.com",
  id,
  template: "Bearer {value}",
  ...overrides,
});

const secret = (overrides: Partial<SecretRecord>): SecretRecord =>
  ({
    createdAt: "2026-10-01T00:00:00.000Z",
    id: "s1",
    mode: "env",
    name: "OPENAI_API_KEY",
    rules: [],
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  }) as SecretRecord;

describe("rule drafts", () => {
  test("a new rule has the default header and template and a fresh id", () => {
    const first = emptyRule();
    const second = emptyRule();
    expect(first.header).toBe("Authorization");
    expect(first.template).toBe("Bearer {value}");
    expect(first.host).toBe("");
    expect(first.id).not.toBe(second.id);
  });

  test("addRule stops at the server's limit", () => {
    const full = Array.from({ length: MAX_RULES }, (_, index) =>
      rule(`r${index}`)
    );
    expect(addRule(full)).toHaveLength(MAX_RULES);
    expect(addRule([rule("a")])).toHaveLength(2);
  });

  test("removeRule keeps the last row", () => {
    const rules = [rule("a"), rule("b")];
    expect(removeRule(rules, "a").map((r) => r.id)).toEqual(["b"]);
    expect(removeRule([rule("a")], "a")).toHaveLength(1);
  });

  test("changeRule edits only the row with that id", () => {
    const rules = [rule("a"), rule("b")];
    const changed = changeRule(rules, "b", "host", "*.example.com");
    expect(changed[0]).toEqual(rules[0] as RuleDraft);
    expect(changed[1]?.host).toBe("*.example.com");
  });

  test("rulesReady needs a host on every row", () => {
    expect(rulesReady([rule("a")])).toBe(true);
    expect(rulesReady([rule("a"), rule("b", { host: "  " })])).toBe(false);
  });

  test("toRules trims host and header but keeps the template", () => {
    expect(
      toRules([
        rule("a", {
          header: " X-Api-Key ",
          host: " api.example.com ",
          template: " {value} ",
        }),
      ])
    ).toEqual([
      { header: "X-Api-Key", host: "api.example.com", template: " {value} " },
    ]);
  });
});

describe("hostsOf", () => {
  test("lists the hosts of a proxy secret, comma separated", () => {
    const proxy = secret({
      mode: "proxy",
      rules: [
        {
          header: "Authorization",
          host: "api.openai.com",
          template: "Bearer {value}",
        },
        { header: "X-Other", host: "*.example.com", template: "{value}" },
      ],
    });
    expect(hostsOf(proxy)).toBe("api.openai.com, *.example.com");
  });

  test("shows a dash for an env secret", () => {
    expect(hostsOf(secret({ mode: "env" }))).toBe("-");
  });
});
