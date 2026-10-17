import { describe, expect, test } from "bun:test";
import type { ProxyMatch } from "@repo/services/secrets";
import {
  MAX_OUTBOUND_BODY_BYTES,
  type OutboundDeps,
  outboundFetch,
} from "./secrets-outbound-core.ts";

const VALUE = "outbound-secret-value-01";
const bearer: ProxyMatch = {
  header: "Authorization",
  headerValue: `Bearer ${VALUE}`,
  name: "OPENAI_API_KEY",
  value: VALUE,
};

interface Harness {
  announced: { host: string; names: string[] }[];
  deps: OutboundDeps;
  logs: string[];
  sent: Request[];
}

const harness = (
  matches: ProxyMatch[],
  answer: () => Response = () => Response.json({ ok: true })
): Harness => {
  const state: Harness = {
    announced: [],
    deps: {
      announce: (host, names) => {
        state.announced.push({ host, names });
        return Promise.resolve();
      },
      fetch: (request) => {
        state.sent.push(request);
        return Promise.resolve(answer());
      },
      log: (line) => {
        state.logs.push(line);
      },
      matches: () => Promise.resolve(matches),
    },
    logs: [],
    sent: [],
  };
  return state;
};

describe("outboundFetch", () => {
  test("a host with no rule passes through unchanged", async () => {
    const h = harness([]);
    const request = new Request("https://example.com/x", {
      headers: { "x-own": "1" },
    });
    await outboundFetch(request, h.deps);
    expect(h.sent).toEqual([request]);
    expect(h.announced).toEqual([]);
  });

  test("a matching host gets the rule's header, and the event names the secret and host", async () => {
    const h = harness([bearer]);
    await outboundFetch(
      new Request("https://api.openai.com/v1/models", {
        body: "payload",
        headers: { Authorization: "Bearer from-the-script" },
        method: "POST",
      }),
      h.deps
    );
    const [sent] = h.sent;
    expect(sent?.headers.get("authorization")).toBe(`Bearer ${VALUE}`);
    expect(sent?.method).toBe("POST");
    expect(await sent?.text()).toBe("payload");
    expect(sent?.redirect).toBe("manual");
    expect(h.announced).toEqual([
      { host: "api.openai.com", names: ["OPENAI_API_KEY"] },
    ]);
    expect(JSON.stringify(h.announced)).not.toContain(VALUE);
  });

  test("two rules on one host set both headers", async () => {
    const second: ProxyMatch = {
      header: "x-api-key",
      headerValue: "other-secret-value-02",
      name: "OTHER_KEY",
      value: "other-secret-value-02",
    };
    const h = harness([bearer, second]);
    await outboundFetch(new Request("https://api.openai.com/"), h.deps);
    expect(h.sent[0]?.headers.get("x-api-key")).toBe("other-secret-value-02");
    expect(h.announced[0]?.names).toEqual(["OPENAI_API_KEY", "OTHER_KEY"]);
  });

  test("a plain http request to a host with a rule is refused and sends nothing", async () => {
    const h = harness([bearer]);
    const response = await outboundFetch(
      new Request("http://api.openai.com/v1"),
      h.deps
    );
    expect(response.status).toBe(403);
    expect(h.sent).toEqual([]);
  });

  test("an answer that echoes the credential comes back scrubbed", async () => {
    const h = harness([bearer], () =>
      Response.json(
        { auth: `Bearer ${VALUE}` },
        { headers: { location: `https://x.test/?k=${VALUE}` }, status: 200 }
      )
    );
    const response = await outboundFetch(
      new Request("https://api.openai.com/"),
      h.deps
    );
    const text = await response.text();
    expect(text).not.toContain(VALUE);
    expect(text).toContain("[secret:OPENAI_API_KEY]");
    expect(response.headers.get("location")).not.toContain(VALUE);
  });

  test("a redirect is handed back, not followed", async () => {
    const h = harness([bearer], () =>
      Response.redirect("https://elsewhere.example/", 302)
    );
    const response = await outboundFetch(
      new Request("https://api.openai.com/"),
      h.deps
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://elsewhere.example/");
    expect(h.sent).toHaveLength(1);
  });

  test("if the rules cannot be read, nothing goes out", async () => {
    const h = harness([]);
    h.deps.matches = () => Promise.reject(new Error("D1 down"));
    const response = await outboundFetch(
      new Request("https://api.openai.com/"),
      h.deps
    );
    expect(response.status).toBe(502);
    expect(h.sent).toEqual([]);
  });

  test("an answer over the cap is refused, not read into memory", async () => {
    const h = harness(
      [bearer],
      () =>
        new Response(new Uint8Array(MAX_OUTBOUND_BODY_BYTES + 1), {
          headers: { "content-type": "application/octet-stream" },
        })
    );
    const response = await outboundFetch(
      new Request("https://api.openai.com/"),
      h.deps
    );
    expect(response.status).toBe(502);
  });

  test("a failed event does not stop the call", async () => {
    const h = harness([bearer]);
    h.deps.announce = () => Promise.reject(new Error("log down"));
    const response = await outboundFetch(
      new Request("https://api.openai.com/"),
      h.deps
    );
    expect(response.status).toBe(200);
    expect(h.logs).toHaveLength(1);
    expect(h.logs.join()).not.toContain(VALUE);
  });
});
