import { describe, expect, test } from "bun:test";
import { ServiceError } from "../errors.ts";
import {
  canonicalJson,
  declaredGrants,
  emptyManifest,
  MANIFEST_PATH,
  parseManifest,
} from "./manifest.ts";

const manifestFile = (value: unknown) => ({
  path: MANIFEST_PATH,
  text: typeof value === "string" ? value : JSON.stringify(value),
});

const serverFile = { path: "server/index.ts", text: "export {};" };

const parseFails = (
  files: readonly { path: string; text?: string }[],
  messagePart: string
) => {
  // biome-ignore lint/suspicious/noMisplacedAssertion: only called from test bodies
  expect(() => parseManifest(files)).toThrow(messagePart);
};

const withHosts = (hosts: unknown) =>
  parseManifest([manifestFile({ hosts }), serverFile]);

describe("parseManifest", () => {
  test("no agentum.json at the root gives an empty manifest", () => {
    expect(parseManifest([])).toEqual(emptyManifest());
    expect(
      parseManifest([{ path: "app/agentum.json", text: "not json" }])
    ).toEqual(emptyManifest());
  });

  test("an empty object gives an empty manifest", () => {
    expect(parseManifest([manifestFile({})])).toEqual(emptyManifest());
  });

  test("a full manifest parses and yields the declared grants", () => {
    const files = [
      manifestFile({
        hosts: ["api.example.com", "cdn.example.org"],
        secrets: ["API_KEY", "_TOKEN2"],
        tools: [
          { tool: "mail/send" },
          {
            limits: {
              folder: { enum: ["inbox", "sent"] },
              limit: { max: 50, min: 1 },
            },
            tool: "mail/search",
          },
        ],
      }),
      serverFile,
    ];

    const manifest = parseManifest(files);
    expect(manifest).toEqual({
      agents: [],
      endpoints: [],
      hosts: ["api.example.com", "cdn.example.org"],
      secrets: ["API_KEY", "_TOKEN2"],
      tools: [
        { tool: "mail/send" },
        {
          limits: {
            folder: { enum: ["inbox", "sent"] },
            limit: { max: 50, min: 1 },
          },
          tool: "mail/search",
        },
      ],
    });

    expect(declaredGrants(manifest)).toEqual([
      { kind: "host", target: "api.example.com" },
      { kind: "host", target: "cdn.example.org" },
      { kind: "secret", target: "API_KEY" },
      { kind: "secret", target: "_TOKEN2" },
      { kind: "tool", target: "mail/search" },
      {
        kind: "tool",
        target:
          'mail/search#{"folder":{"enum":["inbox","sent"]},"limit":{"max":50,"min":1}}',
      },
      { kind: "tool", target: "mail/send" },
    ]);
  });

  test("bad JSON is refused", () => {
    parseFails([manifestFile("{ nope")], "not valid JSON");
  });

  test("a file with no text is refused", () => {
    parseFails([{ path: MANIFEST_PATH }], "has no text to read");
  });

  test("a refusal is a ServiceError with code invalid", () => {
    let caught: unknown;
    try {
      parseManifest([manifestFile("{ nope")]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe("invalid");
  });

  test("an unknown key is refused", () => {
    parseFails([manifestFile({ extra: true, tools: [] })], "extra");
  });

  test("an unknown key inside a tool is refused", () => {
    parseFails(
      [manifestFile({ tools: [{ scope: "all", tool: "mail/send" }] })],
      "scope"
    );
  });

  test("a tool key without exactly one slash is refused", () => {
    for (const tool of ["mail", "a/b/c", "/send", "mail/", "mail send/x"]) {
      parseFails([manifestFile({ tools: [{ tool }] })], "tool");
    }
  });

  test("a tool key over the length limits is refused", () => {
    parseFails(
      [manifestFile({ tools: [{ tool: `${"a".repeat(65)}/send` }] })],
      "tool"
    );
    parseFails(
      [manifestFile({ tools: [{ tool: `mail/${"a".repeat(129)}` }] })],
      "tool"
    );
  });

  test("a duplicate tool is refused", () => {
    parseFails(
      [manifestFile({ tools: [{ tool: "mail/send" }, { tool: "mail/send" }] })],
      'tool "mail/send" is declared twice'
    );
  });

  test("an argument name over 64 characters is refused", () => {
    parseFails(
      [
        manifestFile({
          tools: [
            { limits: { ["a".repeat(65)]: { max: 1 } }, tool: "mail/send" },
          ],
        }),
      ],
      "limits"
    );
  });

  test("an empty limit or an empty enum is refused", () => {
    parseFails(
      [manifestFile({ tools: [{ limits: { to: {} }, tool: "mail/send" }] })],
      "limit needs"
    );
    parseFails(
      [
        manifestFile({
          tools: [{ limits: { to: { enum: [] } }, tool: "mail/send" }],
        }),
      ],
      "enum"
    );
  });

  test("an enum over 50 entries is refused", () => {
    const enumValues = Array.from({ length: 51 }, (_, i) => `v${i}`);
    parseFails(
      [
        manifestFile({
          tools: [{ limits: { to: { enum: enumValues } }, tool: "mail/send" }],
        }),
      ],
      "enum"
    );
  });

  test("more than 50 tools is refused", () => {
    const tools = Array.from({ length: 51 }, (_, i) => ({ tool: `s/t${i}` }));
    parseFails([manifestFile({ tools })], "tools");
  });

  test("hosts are accepted when they are plain lower-case names", () => {
    expect(withHosts(["api.example.com", "a-b.c1.io"]).hosts).toEqual([
      "api.example.com",
      "a-b.c1.io",
    ]);
  });

  test("a host with a scheme, port, path or wildcard is refused", () => {
    for (const host of [
      "https://api.example.com",
      "api.example.com:8443",
      "api.example.com/v1",
      "*.example.com",
    ]) {
      parseFails([manifestFile({ hosts: [host] }), serverFile], "host");
    }
  });

  test("an upper-case host is refused", () => {
    parseFails(
      [manifestFile({ hosts: ["API.example.com"] }), serverFile],
      "lower-case"
    );
  });

  test("an IP literal host is refused", () => {
    parseFails([manifestFile({ hosts: ["10.0.0.1"] }), serverFile], "IP");
  });

  test("localhost and local suffixes are refused", () => {
    for (const host of ["db.localhost", "printer.local", "svc.internal"]) {
      parseFails([manifestFile({ hosts: [host] }), serverFile], "local name");
    }
    parseFails([manifestFile({ hosts: ["localhost"] }), serverFile], "dot");
  });

  test("a host without a dot is refused", () => {
    parseFails([manifestFile({ hosts: ["example"] }), serverFile], "dot");
  });

  test("a host label starting or ending with a hyphen is refused", () => {
    parseFails(
      [manifestFile({ hosts: ["-a.example.com"] }), serverFile],
      "host"
    );
    parseFails(
      [manifestFile({ hosts: ["a-.example.com"] }), serverFile],
      "host"
    );
  });

  test("a host over 253 characters is refused", () => {
    const label = "a".repeat(50);
    const host = [label, label, label, label, label, "com"].join(".");
    expect(host.length).toBeGreaterThan(253);
    parseFails([manifestFile({ hosts: [host] }), serverFile], "253");
  });

  test("a duplicate host is refused", () => {
    parseFails(
      [
        manifestFile({ hosts: ["api.example.com", "api.example.com"] }),
        serverFile,
      ],
      'host "api.example.com" is declared twice'
    );
  });

  test("a bad secret name is refused", () => {
    for (const secret of ["1KEY", "API-KEY", "", "A".repeat(65)]) {
      parseFails([manifestFile({ secrets: [secret] }), serverFile], "secret");
    }
  });

  test("a duplicate secret is refused", () => {
    parseFails(
      [manifestFile({ secrets: ["API_KEY", "API_KEY"] }), serverFile],
      'secret "API_KEY" is declared twice'
    );
  });

  test("hosts or secrets without a server/ file are refused", () => {
    parseFails([manifestFile({ hosts: ["api.example.com"] })], "server/");
    parseFails([manifestFile({ secrets: ["API_KEY"] })], "server/");
    parseFails(
      [manifestFile({ secrets: ["API_KEY"] }), { path: "server.ts", text: "" }],
      "server/"
    );
  });

  test("tools alone do not need a server/ file", () => {
    expect(
      parseManifest([manifestFile({ tools: [{ tool: "mail/send" }] })]).tools
    ).toEqual([{ tool: "mail/send" }]);
  });
});

describe("declaredGrants", () => {
  test("a manifest with no entries declares nothing", () => {
    expect(declaredGrants(emptyManifest())).toEqual([]);
  });

  test("a tool with empty limits adds no limits row", () => {
    expect(
      declaredGrants({
        ...emptyManifest(),
        hosts: [],
        secrets: [],
        tools: [{ limits: {}, tool: "mail/send" }],
      })
    ).toEqual([{ kind: "tool", target: "mail/send" }]);
  });

  test("duplicate grants are dropped", () => {
    expect(
      declaredGrants({
        ...emptyManifest(),
        hosts: ["a.example.com"],
        secrets: [],
        tools: [{ tool: "mail/send" }, { tool: "mail/send" }],
      })
    ).toEqual([
      { kind: "host", target: "a.example.com" },
      { kind: "tool", target: "mail/send" },
    ]);
  });
});

describe("canonicalJson", () => {
  test("object key order does not change the output", () => {
    const a = { a: { c: "x", d: [1, { x: 1, y: 2 }] }, b: 1 };
    const b = { a: { c: "x", d: [1, { x: 1, y: 2 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe(
      '{"a":{"c":"x","d":[1,{"x":1,"y":2}]},"b":1}'
    );
  });

  test("array order is kept", () => {
    expect(canonicalJson([2, 1])).toBe("[2,1]");
    expect(canonicalJson({ list: ["b", "a"] })).toBe('{"list":["b","a"]}');
  });
});

test("endpoint and agent declarations parse and become grants", () => {
  const parsed = parseManifest([
    manifestFile({
      agents: [{ agent: "agent-1" }],
      endpoints: [{ name: "discord" }],
    }),
    serverFile,
  ]);
  expect(parsed.endpoints).toEqual([{ name: "discord" }]);
  expect(parsed.agents).toEqual([{ agent: "agent-1" }]);
  expect(declaredGrants(parsed)).toEqual([
    { kind: "agent", target: "agent-1" },
    { kind: "endpoint", target: "discord" },
  ]);
});

test("endpoints and agents need server code, unique entries and at most five entries", () => {
  for (const [field, entry] of [
    ["endpoints", { name: "discord" }],
    ["agents", { agent: "agent-1" }],
  ] as const) {
    parseFails([manifestFile({ [field]: [entry] })], "server/");
    parseFails(
      [manifestFile({ [field]: [entry, entry] }), serverFile],
      "declared twice"
    );
    parseFails(
      [
        manifestFile({
          [field]: Array.from({ length: 6 }, (_, i) =>
            field === "endpoints" ? { name: `e-${i}` } : { agent: `a-${i}` }
          ),
        }),
        serverFile,
      ],
      field
    );
  }
});

test("endpoint names and agent ids are bounded", () => {
  for (const name of ["", "Discord", "a_b", "a".repeat(41)]) {
    parseFails(
      [manifestFile({ endpoints: [{ name }] }), serverFile],
      "endpoints"
    );
  }
  for (const agent of ["", "a".repeat(201)]) {
    parseFails([manifestFile({ agents: [{ agent }] }), serverFile], "agents");
  }
  expect(
    parseManifest([
      manifestFile({ endpoints: [{ name: "a".repeat(40) }] }),
      serverFile,
    ]).endpoints
  ).toHaveLength(1);
});
