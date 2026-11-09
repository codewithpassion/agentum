import { describe, expect, test } from "bun:test";
import {
  addRule,
  changeRule,
  connectorsAtRisk,
  emptyRule,
  hostsOf,
  hostsText,
  MAX_RULES,
  modeChangeDefaults,
  modePatch,
  parseHosts,
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

  test("lists the allowed hosts of an env secret", () => {
    expect(
      hostsOf(
        secret({
          allowedHosts: ["api.example.com", "*.example.org"],
          mode: "env",
        })
      )
    ).toBe("api.example.com, *.example.org");
  });

  test("shows a dash for an env secret without allowed hosts", () => {
    expect(hostsOf(secret({ allowedHosts: [], mode: "env" }))).toBe("-");
  });
});

describe("parseHosts", () => {
  test("splits on commas and whitespace, including newlines", () => {
    expect(
      parseHosts("api.example.com,*.example.org\n  x.example.net\tz.io")
    ).toEqual(["api.example.com", "*.example.org", "x.example.net", "z.io"]);
  });

  test("drops duplicates and keeps the first position", () => {
    expect(parseHosts("a.io, b.io, a.io b.io c.io")).toEqual([
      "a.io",
      "b.io",
      "c.io",
    ]);
  });

  test("drops empty entries from stray commas and spaces", () => {
    expect(parseHosts(" ,, a.io ,, ,b.io, ")).toEqual(["a.io", "b.io"]);
  });

  test("an empty or blank string gives no hosts", () => {
    expect(parseHosts("")).toEqual([]);
    expect(parseHosts(" \n , ")).toEqual([]);
  });
});

describe("hostsText", () => {
  test("joins hosts with a comma and a space", () => {
    expect(hostsText(["a.io", "*.b.io"])).toBe("a.io, *.b.io");
  });

  test("gives an empty string for no hosts", () => {
    expect(hostsText([])).toBe("");
  });

  test("round-trips through parseHosts", () => {
    const hosts = ["api.example.com", "*.example.org"];
    expect(parseHosts(hostsText(hosts))).toEqual(hosts);
  });
});

describe("changing a secret's mode", () => {
  test("a proxy secret's rule hosts become allowed hosts, once each", () => {
    const defaults = modeChangeDefaults(
      secret({
        mode: "proxy",
        rules: [
          { header: "x-api-key", host: "api.example.com", template: "{value}" },
          { header: "x-other", host: "api.example.com", template: "{value}" },
          { header: "x-api-key", host: "*.example.org", template: "{value}" },
        ],
      })
    );
    expect(defaults.hosts).toBe("api.example.com, *.example.org");
  });

  test("an env secret's allowed hosts become rules with the default header and template", () => {
    const defaults = modeChangeDefaults(
      secret({
        allowedHosts: ["api.example.com", "b.example.com"],
        mode: "env",
      })
    );
    expect(
      defaults.rules.map(({ header, host, template }) => ({
        header,
        host,
        template,
      }))
    ).toEqual([
      {
        header: "Authorization",
        host: "api.example.com",
        template: "Bearer {value}",
      },
      {
        header: "Authorization",
        host: "b.example.com",
        template: "Bearer {value}",
      },
    ]);
  });

  test("an env secret with no hosts starts with one empty rule", () => {
    const defaults = modeChangeDefaults(
      secret({ allowedHosts: [], mode: "env" })
    );
    expect(defaults.rules).toHaveLength(1);
    expect(defaults.rules[0]?.host).toBe("");
  });

  test("the patch carries the mode and only that mode's settings", () => {
    expect(
      modePatch(
        "env",
        [rule("a", { host: "x.example.com" })],
        "a.example.com, b.example.com"
      )
    ).toEqual({
      allowedHosts: ["a.example.com", "b.example.com"],
      mode: "env",
    });
    expect(
      modePatch("proxy", [rule("a", { host: " x.example.com " })], "ignored")
    ).toEqual({
      mode: "proxy",
      rules: [
        {
          header: "Authorization",
          host: "x.example.com",
          template: "Bearer {value}",
        },
      ],
    });
  });

  test("a linked connector whose host the new hosts do not allow is named", () => {
    const connectors = [
      { name: "Docs", secretId: "s1", url: "https://api.example.com/mcp" },
      { name: "Wiki", secretId: "s1", url: "https://wiki.example.com/mcp" },
      { name: "Other", secretId: "s2", url: "https://nowhere.example.net/mcp" },
    ];
    expect(connectorsAtRisk(connectors, "s1", ["api.example.com"])).toEqual([
      "Wiki",
    ]);
    expect(connectorsAtRisk(connectors, "s1", ["*.example.com"])).toEqual([]);
    expect(connectorsAtRisk(connectors, "s1", [])).toEqual(["Docs", "Wiki"]);
  });
});
