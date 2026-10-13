import { describe, expect, mock, test } from "bun:test";
import { generateConnectorKey } from "#/crypto";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  env: {},
}));

const { sendImageToAgentSession, signedImageUrl } = await import("./send");

const KEY = generateConnectorKey();
const DIGITS = /^\d+$/;

const envWith = (
  deliverImage: (input: unknown) => Promise<unknown>,
  key: string | null = KEY
): Env =>
  ({
    AGENT_ROUTER: {
      get: () => ({ deliverImage }),
      idFromName: (name: string) => name,
    },
    ATTACHMENT_LINK_KEY: key ?? undefined,
  }) as unknown as Env;

const input = {
  agentId: "agent-1",
  caption: "Screenshot of https://example.com",
  origin: "https://app.example.com/",
  r2Key: "browser/agent-1/shot.png",
  workspaceId: "ws-1",
};

describe("signedImageUrl", () => {
  test("is absolute on the origin and carries key, exp and sig", async () => {
    const url = new URL(
      await signedImageUrl(KEY, "https://app.example.com/", input.r2Key)
    );

    expect(url.origin).toBe("https://app.example.com");
    expect(url.pathname).toBe("/api/agent-images");
    expect(url.searchParams.get("key")).toBe(input.r2Key);
    expect(url.searchParams.get("exp")).toMatch(DIGITS);
    expect(url.searchParams.get("sig")).toBeTruthy();
  });
});

describe("sendImageToAgentSession", () => {
  test("hands the router a signed url and reports a send", async () => {
    const calls: { caption: string; imageUrl: string }[] = [];
    const result = await sendImageToAgentSession(
      envWith((call) => {
        calls.push(call as { caption: string; imageUrl: string });
        return Promise.resolve({ sent: true });
      }),
      input
    );

    expect(result).toEqual({ sent: true });
    expect(calls[0]?.caption).toBe(input.caption);
    expect(calls[0]?.imageUrl).toContain(
      "https://app.example.com/api/agent-images?"
    );
  });

  test("passes on the router's answer when no session is running", async () => {
    const result = await sendImageToAgentSession(
      envWith(() =>
        Promise.resolve({
          reason: "The agent has no running session.",
          sent: false,
        })
      ),
      input
    );

    expect(result).toEqual({
      reason: "The agent has no running session.",
      sent: false,
    });
  });

  test("returns a reason instead of throwing without a signing key", async () => {
    const result = await sendImageToAgentSession(
      envWith(() => Promise.resolve({ sent: true }), null),
      input
    );

    expect(result.sent).toBe(false);
  });
});
