import { describe, expect, test } from "bun:test";
import type { ProxyMatch } from "@repo/services/secrets";
import { appOutboundFetch } from "./app-outbound-core.ts";
import { fakePorts } from "./fakes.ts";

const props = { artifactId: "a1", versionId: "v1", workspaceId: "ws-1" };
const VALUE = "app-secret-value-0001";
const bearer: ProxyMatch = {
  header: "Authorization",
  headerValue: `Bearer ${VALUE}`,
  name: "API_KEY",
  value: VALUE,
};

const setup = (hosts: string[], rules: ProxyMatch[] = []) => {
  const ports = fakePorts();
  ports.hosts.list = hosts;
  ports.grants.secretRules = () => Promise.resolve(rules);
  const announced: { host: string; names: string[] }[] = [];
  ports.grants.announce = (_props, host, names) => {
    announced.push({ host, names });
    return Promise.resolve();
  };
  const sent: Request[] = [];
  const logs: string[] = [];
  const run = (url: string, init?: RequestInit) =>
    appOutboundFetch(new Request(url, init), props, {
      fetch: (request) => {
        sent.push(request);
        return Promise.resolve(Response.json({ ok: true }));
      },
      grants: ports.grants,
      log: (line) => logs.push(line),
    });
  return { announced, logs, ports, run, sent };
};

describe("appOutboundFetch", () => {
  test("an approved host passes through", async () => {
    const t = setup(["api.example.com"]);
    const answer = await t.run("https://api.example.com/x");
    expect(answer.status).toBe(200);
    expect(t.sent.length).toBe(1);
  });

  test("a request goes out with redirects left to the app, so a redirect cannot skip the allowlist", async () => {
    const t = setup(["api.example.com"]);
    await t.run("https://api.example.com/x");
    expect(t.sent.at(0)?.redirect).toBe("manual");
  });

  test("a host that is not approved gets 403 and nothing is sent", async () => {
    const t = setup(["api.example.com"]);
    const answer = await t.run("https://blocked.test/");
    expect(answer.status).toBe(403);
    expect(t.sent).toEqual([]);
  });

  test("with no approved host everything is refused", async () => {
    const t = setup([]);
    expect((await t.run("https://api.example.com/")).status).toBe(403);
    expect(t.sent).toEqual([]);
  });

  test("the list is read on every request", async () => {
    const t = setup([]);
    expect((await t.run("https://api.example.com/")).status).toBe(403);
    t.ports.hosts.list = ["api.example.com"];
    expect((await t.run("https://api.example.com/")).status).toBe(200);
    expect(t.ports.hosts.reads).toBe(2);
  });

  test("host names compare without case, and a subdomain is not the host", async () => {
    const t = setup(["API.Example.com"]);
    expect((await t.run("https://api.example.com/")).status).toBe(200);
    expect((await t.run("https://evil.api.example.com/")).status).toBe(403);
  });

  test("plain http is refused even for an approved host", async () => {
    const t = setup(["api.example.com"]);
    expect((await t.run("http://api.example.com/")).status).toBe(403);
    expect(t.sent).toEqual([]);
  });

  test("a failed read of the list fails closed with 502", async () => {
    const t = setup(["api.example.com"]);
    t.ports.grants.approvedHosts = () => Promise.reject(new Error("db down"));
    const answer = await t.run("https://api.example.com/");
    expect(answer.status).toBe(502);
    expect(await answer.text()).not.toContain("db down");
    expect(t.sent).toEqual([]);
    expect(t.logs.length).toBe(1);
  });

  test("a secret rule adds its header to an approved host and is announced by name", async () => {
    const t = setup(["api.example.com"], [bearer]);
    await t.run("https://api.example.com/x");
    expect(t.sent[0]?.headers.get("authorization")).toBe(`Bearer ${VALUE}`);
    expect(t.announced).toEqual([
      { host: "api.example.com", names: ["API_KEY"] },
    ]);
  });
});
