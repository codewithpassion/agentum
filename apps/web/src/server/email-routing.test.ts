import { describe, expect, test } from "bun:test";
import { RoutingNotConfiguredError } from "@repo/services/mail/types";
import { createEmailRoutingPort } from "./email-routing.ts";

const BASE =
  "https://api.cloudflare.com/client/v4/zones/zone-1/email/routing/rules";
const TOKEN = "cf-token-secret";
const WORKER = "harbourmaster-worker";
const LIMIT_MESSAGE =
  "Email Routing rule limit reached for this domain (about 200 rules)";

interface Call {
  init: RequestInit;
  url: string;
}

/** A fetch that records each call and answers with the canned responses in order. */
const fakeFetch = (responses: Response[]) => {
  const calls: Call[] = [];
  const send = (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ init: init ?? {}, url });
    const next = responses.shift();
    return next
      ? Promise.resolve(next)
      : Promise.reject(new Error(`unexpected fetch to ${url}`));
  };
  return { calls, send };
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });

const envelope = (result: unknown, resultInfo?: { total_pages: number }) =>
  json({
    errors: [],
    messages: [],
    result,
    result_info: resultInfo,
    success: true,
  });

const failed = (
  errors: { code: number | string; message: string }[],
  status = 400
) => json({ errors, messages: [], result: null, success: false }, status);

const portWith = (
  responses: Response[],
  overrides: Partial<{ token: string; zoneId: string; workerName: string }> = {}
) => {
  const fake = fakeFetch(responses);
  const port = createEmailRoutingPort({
    fetch: fake.send,
    token: TOKEN,
    workerName: WORKER,
    zoneId: "zone-1",
    ...overrides,
  });
  return { ...fake, port };
};

const rule = (id: string, name: string, value: string) => ({
  actions: [{ type: "worker", value: [WORKER] }],
  enabled: true,
  id,
  matchers: [{ field: "to", type: "literal", value }],
  name,
});

describe("createEmailRoutingPort without configuration", () => {
  const missing = [
    { token: undefined, workerName: WORKER, zoneId: "zone-1" },
    { token: "", workerName: WORKER, zoneId: "zone-1" },
    { token: TOKEN, workerName: WORKER, zoneId: undefined },
    { token: TOKEN, workerName: WORKER, zoneId: "" },
    { token: TOKEN, workerName: undefined, zoneId: "zone-1" },
    { token: TOKEN, workerName: "", zoneId: "zone-1" },
  ];

  test.each(missing)(
    "every method throws without a network call: %o",
    async (config) => {
      const { calls, port } = portWith([], config);
      await expect(port.createRule("agent@example.com")).rejects.toThrow(
        RoutingNotConfiguredError
      );
      await expect(port.findRule("agent@example.com")).rejects.toThrow(
        RoutingNotConfiguredError
      );
      await expect(port.deleteRule("rule-1")).rejects.toThrow(
        RoutingNotConfiguredError
      );
      expect(calls).toHaveLength(0);
    }
  );
});

describe("createRule", () => {
  test("sends the documented request and returns the rule id", async () => {
    const { calls, port } = portWith([envelope({ id: "rule-9" })]);

    const created = await port.createRule("Agent.One@Example.com");

    expect(created).toEqual({ id: "rule-9" });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(BASE);
    expect(call?.init.method).toBe("POST");
    const headers = new Headers(call?.init.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(call?.init.body))).toEqual({
      actions: [{ type: "worker", value: [WORKER] }],
      enabled: true,
      matchers: [
        { field: "to", type: "literal", value: "agent.one@example.com" },
      ],
      name: "harbourmaster:agent.one@example.com",
    });
  });
});

describe("findRule", () => {
  test("pages through the list and matches case-insensitively", async () => {
    const { calls, port } = portWith([
      envelope([rule("other-1", "unrelated", "someone@example.com")], {
        total_pages: 2,
      }),
      envelope(
        [
          rule(
            "rule-2",
            "harbourmaster:agent@example.com",
            "AGENT@example.com"
          ),
        ],
        {
          total_pages: 2,
        }
      ),
    ]);

    const found = await port.findRule("Agent@Example.com");

    expect(found).toEqual({ id: "rule-2", managed: true });
    expect(calls.map((call) => call.url)).toEqual([
      `${BASE}?page=1&per_page=50`,
      `${BASE}?page=2&per_page=50`,
    ]);
    expect(calls.every((call) => call.init.method === undefined)).toBe(true);
  });

  test("reports managed false for a rule with another name", async () => {
    const { port } = portWith([
      envelope([rule("rule-3", "Catch all", "agent@example.com")], {
        total_pages: 1,
      }),
    ]);

    expect(await port.findRule("agent@example.com")).toEqual({
      id: "rule-3",
      managed: false,
    });
  });

  test("returns null when no rule matches", async () => {
    const { calls, port } = portWith([
      envelope(
        [
          rule(
            "rule-4",
            "harbourmaster:other@example.com",
            "other@example.com"
          ),
        ],
        {
          total_pages: 1,
        }
      ),
    ]);

    expect(await port.findRule("agent@example.com")).toBeNull();
    expect(calls).toHaveLength(1);
  });

  test("ignores matchers that are not literal to-field matches", async () => {
    const { port } = portWith([
      envelope(
        [
          {
            actions: [],
            id: "rule-5",
            matchers: [{ type: "all" }],
            name: "all",
          },
        ],
        { total_pages: 1 }
      ),
    ]);

    expect(await port.findRule("agent@example.com")).toBeNull();
  });
});

describe("deleteRule", () => {
  test("deletes the encoded rule url", async () => {
    const { calls, port } = portWith([envelope({ id: "a/b" })]);

    await port.deleteRule("a/b");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BASE}/a%2Fb`);
    expect(calls[0]?.init.method).toBe("DELETE");
  });

  test("treats a 404 as success", async () => {
    const { port } = portWith([new Response(null, { status: 404 })]);

    await expect(port.deleteRule("gone")).resolves.toBeUndefined();
  });

  test("treats a not found error code as success", async () => {
    const { port } = portWith([
      failed([{ code: "not found", message: "Rule gone" }], 400),
    ]);

    await expect(port.deleteRule("gone")).resolves.toBeUndefined();
  });

  test("throws on other failures", async () => {
    const { port } = portWith([
      failed([{ code: 10_000, message: "Forbidden" }], 403),
    ]);

    await expect(port.deleteRule("rule-1")).rejects.toThrow(
      "Cloudflare Email Routing: Forbidden"
    );
  });
});

describe("error envelopes", () => {
  test("joins the Cloudflare messages", async () => {
    const { port } = portWith([
      failed([
        { code: 1, message: "First problem" },
        { code: 2, message: "Second problem" },
      ]),
    ]);

    await expect(port.createRule("agent@example.com")).rejects.toThrow(
      "Cloudflare Email Routing: First problem; Second problem"
    );
  });

  test("falls back to the HTTP status when there are no messages", async () => {
    const { port } = portWith([new Response("upstream down", { status: 502 })]);

    await expect(port.createRule("agent@example.com")).rejects.toThrow(
      "Cloudflare Email Routing: HTTP 502"
    );
  });

  test("reports a rule limit in plain words", async () => {
    const { port } = portWith([
      failed([{ code: 81_000, message: "Maximum number of rules reached" }]),
    ]);

    await expect(port.createRule("agent@example.com")).rejects.toThrow(
      LIMIT_MESSAGE
    );
  });

  test("never includes the token in a message", async () => {
    const { port } = portWith([
      failed([{ code: 1, message: `Bad token ${TOKEN}` }], 401),
    ]);

    const error = await port
      .createRule("agent@example.com")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(TOKEN);
  });
});
