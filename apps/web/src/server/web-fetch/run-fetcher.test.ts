import { describe, expect, test } from "bun:test";
import type { NetworkRequestEntry } from "@repo/services/network";
import type { ProxyMatch } from "@repo/services/secrets";
import type { Services } from "../compose.ts";
import { runWebFetcher } from "./run-fetcher.ts";

const RUN = { agentId: "agent-1", runId: "run-1", workspaceId: "ws-1" };
const KEY = "SK_TEST_VALUE_123";
const RULE: ProxyMatch = {
  header: "authorization",
  headerValue: `Bearer ${KEY}`,
  name: "API_KEY",
  value: KEY,
};

interface Announced {
  injection: { host: string; names: readonly string[]; via: string };
  run: unknown;
}

function harness() {
  const sent: Request[] = [];
  const announced: Announced[] = [];
  const recorded: { entry: NetworkRequestEntry; run: unknown }[] = [];
  const services = {
    network: {
      recordRequest: (run: unknown, entry: NetworkRequestEntry) => {
        recorded.push({ entry, run });
        return Promise.resolve();
      },
    },
    secrets: {
      announceInjection: (run: unknown, injection: Announced["injection"]) => {
        announced.push({ injection, run });
        return Promise.resolve();
      },
      proxyFor: (workspaceId: string, agentId: string, host: string) =>
        Promise.resolve(
          workspaceId === RUN.workspaceId &&
            agentId === RUN.agentId &&
            host === "api.example.com"
            ? [RULE]
            : []
        ),
    },
  } as unknown as Pick<Services, "network" | "secrets">;
  return { announced, recorded, sent, services };
}

const answer = () => new Response("ok", { status: 200 });

describe("runWebFetcher", () => {
  test("adds the rule header over https and announces the injection", async () => {
    const h = harness();
    const fetcher = runWebFetcher({
      fetch: (request) => {
        h.sent.push(request);
        return Promise.resolve(answer());
      },
      ownHosts: [],
      run: RUN,
      services: h.services,
      via: "web_fetch",
    });

    const result = await fetcher({ url: "https://api.example.com/v1/items" });

    expect(result.ok).toBe(true);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(h.announced).toEqual([
      {
        injection: {
          host: "api.example.com",
          names: ["API_KEY"],
          via: "web_fetch",
        },
        run: RUN,
      },
    ]);
  });

  test("sends a host with no rule without the header and without an announcement", async () => {
    const h = harness();
    const fetcher = runWebFetcher({
      fetch: (request) => {
        h.sent.push(request);
        return Promise.resolve(answer());
      },
      ownHosts: [],
      run: RUN,
      services: h.services,
      via: "curl",
    });

    const result = await fetcher({ url: "https://other.example.com/" });

    expect(result.ok).toBe(true);
    expect(h.sent[0]?.headers.get("authorization")).toBeNull();
    expect(h.announced).toEqual([]);
  });

  test("records each request with the run ids and the caller's via", async () => {
    const h = harness();
    const fetcher = runWebFetcher({
      fetch: (request) => {
        h.sent.push(request);
        return Promise.resolve(answer());
      },
      ownHosts: [],
      run: RUN,
      services: h.services,
      via: "curl",
    });

    await fetcher({ url: "https://other.example.com/" });
    await fetcher({ url: "http://127.0.0.1/" });

    expect(h.recorded.map((r) => r.run)).toEqual([RUN, RUN]);
    expect(h.recorded.map((r) => r.entry.via)).toEqual(["curl", "curl"]);
  });

  test("refuses a loopback address before it reaches fetch", async () => {
    const h = harness();
    const fetcher = runWebFetcher({
      fetch: (request) => {
        h.sent.push(request);
        return Promise.resolve(answer());
      },
      ownHosts: [],
      run: RUN,
      services: h.services,
      via: "web_fetch",
    });

    const result = await fetcher({ url: "http://127.0.0.1/" });

    expect(result.ok).toBe(false);
    expect(h.sent).toEqual([]);
    expect(h.recorded.map((r) => r.entry.via)).toEqual(["web_fetch"]);
  });

  test("the recorded entry holds no query string and no header value", async () => {
    const h = harness();
    const fetcher = runWebFetcher({
      fetch: (request) => {
        h.sent.push(request);
        return Promise.resolve(answer());
      },
      ownHosts: [],
      run: RUN,
      services: h.services,
      via: "web_fetch",
    });

    await fetcher({
      headers: { "x-trace": "TRACE_HEADER_VALUE" },
      url: "https://api.example.com/v1/items?token=QUERY_SECRET_VALUE",
    });

    const entries = h.recorded.map((r) => r.entry);
    expect(entries.map((entry) => entry.host)).toEqual(["api.example.com"]);
    const logged = JSON.stringify(entries);
    expect(logged).not.toContain("QUERY_SECRET_VALUE");
    expect(logged).not.toContain("TRACE_HEADER_VALUE");
    expect(logged).not.toContain(KEY);
  });
});
