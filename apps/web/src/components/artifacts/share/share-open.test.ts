import { expect, test } from "bun:test";
import { openShare } from "./share-open.ts";

const BODY = {
  agentName: "Scribe",
  contentUrl: "/a/6f1c1d52-0c1e-4b7a-9d5e-2a3b4c5d6e7f/c/hm_view_x/",
  expiresAt: "2026-10-27T01:00:00.000Z",
  kind: "page",
  ownerName: "Dom",
  title: "Plan",
  version: { createdAt: "2026-10-27T00:00:00.000Z", number: 1 },
  workspaceName: "Acme",
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

test("a 200 with a valid body returns the data, and posts to the encoded url", async () => {
  const calls: { init?: RequestInit; url: string }[] = [];
  const fetchFn = ((url: string, init?: RequestInit) => {
    calls.push({ init, url });
    return Promise.resolve(json(200, BODY));
  }) as unknown as typeof fetch;
  const result = await openShare("hm_share_a/b", fetchFn);
  expect(result).toEqual({ data: BODY as never, ok: true });
  expect(calls[0]?.url).toBe("/api/share/hm_share_a%2Fb/open");
  expect(calls[0]?.init?.method).toBe("POST");
});

test("a 404 is not available", async () => {
  const fetchFn = (() =>
    Promise.resolve(
      json(404, { error: "This link is not available." })
    )) as unknown as typeof fetch;
  expect(await openShare("t", fetchFn)).toEqual({ ok: false });
});

test("a 200 with an invalid body is not available", async () => {
  const fetchFn = (() =>
    Promise.resolve(json(200, { title: "x" }))) as unknown as typeof fetch;
  expect(await openShare("t", fetchFn)).toEqual({ ok: false });
});

test("a network error is not available", async () => {
  const fetchFn = (() =>
    Promise.reject(new Error("offline"))) as unknown as typeof fetch;
  expect(await openShare("t", fetchFn)).toEqual({ ok: false });
});
