import { describe, expect, test } from "bun:test";
import { serve } from "bun";
import { promptForMessageId } from "./a2a-tck-prompts.ts";
import { rewriteMessage, startTckProxy } from "./a2a-tck-proxy.ts";

const prompt = (messageId: string): string | null =>
  messageId.startsWith("m1") ? "say Hi" : null;

const suffixed = /^m1-p\d+$/;
const otherSuffixed = /^other-p\d+$/;
const tckSuffixed = /^tck-complete-task-abc-p\d+$/;

const freePort = (): number => {
  const probe = serve({ fetch: () => new Response(""), port: 0 });
  const port = Number(probe.port);
  probe.stop(true);
  return port;
};

describe("rewriteMessage", () => {
  test("replaces the first text part of a JSON-RPC body with the prompt", () => {
    const body = {
      params: { message: { messageId: "m1", parts: [{ text: "original" }] } },
    };
    const out = rewriteMessage(body, prompt) as typeof body;
    expect(out.params.message.parts[0]?.text).toBe("say Hi");
  });

  test("replaces the first text part of a REST body with the prompt", () => {
    const body = {
      message: { messageId: "m1", parts: [{ text: "original" }] },
    };
    const out = rewriteMessage(body, prompt) as typeof body;
    expect(out.message.parts[0]?.text).toBe("say Hi");
  });

  test("suffixes the message id with a unique -p number on each call", () => {
    const first = rewriteMessage(
      { message: { messageId: "m1", parts: [] } },
      prompt
    ) as { message: { messageId: string } };
    const second = rewriteMessage(
      { message: { messageId: "m1", parts: [] } },
      prompt
    ) as { message: { messageId: string } };
    expect(first.message.messageId).toMatch(suffixed);
    expect(second.message.messageId).toMatch(suffixed);
    expect(first.message.messageId).not.toBe(second.message.messageId);
  });

  test("leaves the text alone but still makes the id unique when the prompt is null", () => {
    const body = { message: { messageId: "other", parts: [{ text: "keep" }] } };
    const out = rewriteMessage(body, prompt) as typeof body;
    expect(out.message.parts[0]?.text).toBe("keep");
    expect(out.message.messageId).toMatch(otherSuffixed);
  });

  test("returns a body with no message as is", () => {
    const body = { method: "GetTask", params: { id: "t1" } };
    expect(rewriteMessage(body, prompt)).toEqual({
      method: "GetTask",
      params: { id: "t1" },
    });
  });

  test("leaves a non-text first part alone", () => {
    const parts = [{ url: "https://example.com/a.png" }, { text: "second" }];
    const body = { message: { messageId: "m1", parts } };
    const out = rewriteMessage(body, prompt) as typeof body;
    expect(out.message.parts).toEqual([
      { url: "https://example.com/a.png" },
      { text: "second" },
    ]);
  });
});

describe("promptForMessageId", () => {
  test("maps a complete-task id to the hello prompt", () => {
    expect(promptForMessageId("tck-complete-task-abc")).toBe(
      "say Hello from TCK"
    );
  });

  test("maps a stream artifact id to the artifact text prompt, not the generic stream one", () => {
    expect(promptForMessageId("tck-stream-artifact-text-1")).toBe(
      "say Streamed text content"
    );
  });

  test("maps a generic stream id to the generic stream prompt", () => {
    expect(promptForMessageId("tck-stream-anything")).toBe(
      "say Stream hello from TCK"
    );
  });

  test("gives null for a reject-task id the agent has no behaviour for", () => {
    expect(promptForMessageId("tck-reject-task-1")).toBeNull();
  });

  test("gives null for an unknown id", () => {
    expect(promptForMessageId("unknown-id")).toBeNull();
  });
});

describe("startTckProxy", () => {
  test("serves the card at the proxy, adds the key, and rewrites SendMessage", async () => {
    const upstreamServer = serve({
      fetch: async (request) => {
        const url = new URL(request.url);
        const { origin } = url;
        if (url.pathname === "/a2a/pub1/.well-known/agent-card.json") {
          return Response.json({
            name: "pub1",
            supportedInterfaces: [
              { protocolBinding: "JSONRPC", url: `${origin}/a2a/pub1/rpc` },
              { protocolBinding: "HTTP+JSON", url: `${origin}/a2a/pub1/http` },
            ],
          });
        }
        if (url.pathname === "/a2a/pub1/rpc" && request.method === "POST") {
          return Response.json({
            authorization: request.headers.get("authorization"),
            body: await request.json(),
          });
        }
        return new Response("not found", { status: 404 });
      },
      port: 0,
    });
    const upstream = `http://localhost:${upstreamServer.port}`;
    const port = freePort();
    const proxy = startTckProxy({
      port,
      promptFor: promptForMessageId,
      publicId: "pub1",
      token: "tok",
      upstream,
    });
    try {
      const card = (await (
        await fetch(`${proxy.host}/.well-known/agent-card.json`)
      ).json()) as { supportedInterfaces: { url: string }[] };
      expect(card.supportedInterfaces.map((entry) => entry.url)).toEqual([
        `${proxy.host}/a2a/pub1/rpc`,
        `${proxy.host}/a2a/pub1/http`,
      ]);

      const message = {
        messageId: "tck-complete-task-abc",
        parts: [{ text: "original" }],
      };
      const sent = await fetch(`${proxy.host}/a2a/pub1/rpc`, {
        body: JSON.stringify({ method: "SendMessage", params: { message } }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const echoed = (await sent.json()) as {
        authorization: string | null;
        body: {
          params: { message: { messageId: string; parts: { text: string }[] } };
        };
      };
      expect(echoed.authorization).toBe("Bearer tok");
      expect(echoed.body.params.message.parts[0]?.text).toBe(
        "say Hello from TCK"
      );
      expect(echoed.body.params.message.messageId).toMatch(tckSuffixed);

      const own = await fetch(`${proxy.host}/a2a/pub1/rpc`, {
        body: JSON.stringify({ method: "GetTask", params: { id: "t1" } }),
        headers: {
          authorization: "Bearer own",
          "content-type": "application/json",
        },
        method: "POST",
      });
      const kept = (await own.json()) as { authorization: string | null };
      expect(kept.authorization).toBe("Bearer own");
    } finally {
      proxy.stop();
      upstreamServer.stop(true);
    }
  });
});
