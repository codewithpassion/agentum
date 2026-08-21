import { describe, expect, test } from "bun:test";
import { createSlackClient } from "./client";

/** The Slack Web API is faked at the `fetch` boundary - no live call is made. */

interface Call {
  body: string;
  url: string;
}

/** Fails loudly rather than asserting against an absent call. */
const callAt = (calls: Call[], index: number): Call => {
  const call = calls[index];
  if (!call) {
    throw new Error(`Expected a Slack call at index ${index}.`);
  }
  return call;
};

const jsonResponse = (payload: unknown): Response => Response.json(payload);

const rateLimited = (retryAfterSeconds: number): Response =>
  new Response("", {
    headers: { "retry-after": String(retryAfterSeconds) },
    status: 429,
  });

const recorder = (responses: Response[]) => {
  const calls: Call[] = [];
  const slept: number[] = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      body: typeof init?.body === "string" ? init.body : "",
      url: String(input),
    });
    return Promise.resolve(
      responses.shift() ?? new Response("", { status: 500 })
    );
  }) as typeof fetch;

  return {
    calls,
    client: createSlackClient("xoxb-test-token", {
      fetchImpl,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    }),
    slept,
  };
};

describe("postMessage", () => {
  test("sends the text, the channel and the thread", async () => {
    const { calls, client } = recorder([
      jsonResponse({ ok: true, ts: "1787200000.000900" }),
    ]);

    const posted = await client.postMessage({
      channel: "C0OPSCHAN",
      text: "hello",
      threadTs: "1787200000.000100",
    });

    expect(posted).toEqual({ ts: "1787200000.000900" });
    expect(callAt(calls, 0).url).toBe("https://slack.com/api/chat.postMessage");
    expect(JSON.parse(callAt(calls, 0).body)).toEqual({
      channel: "C0OPSCHAN",
      text: "hello",
      thread_ts: "1787200000.000100",
    });
  });

  test("retries once on 429, waiting the Retry-After it was given", async () => {
    const { calls, client, slept } = recorder([
      rateLimited(2),
      jsonResponse({ ok: true, ts: "1787200000.000900" }),
    ]);

    const posted = await client.postMessage({
      channel: "C0OPSCHAN",
      text: "hello",
    });

    expect(posted).toEqual({ ts: "1787200000.000900" });
    expect(calls).toHaveLength(2);
    expect(slept).toEqual([2000]);
  });

  test("gives up after a second 429 rather than blocking the caller", async () => {
    const { calls, client } = recorder([rateLimited(1), rateLimited(1)]);

    expect(
      await client.postMessage({ channel: "C0OPSCHAN", text: "hello" })
    ).toBeNull();
    expect(calls).toHaveLength(2);
  });

  test("treats an API-level error as a failed post, not an exception", async () => {
    const { client } = recorder([
      jsonResponse({ error: "channel_not_found", ok: false }),
    ]);

    expect(
      await client.postMessage({ channel: "C0GONE", text: "hello" })
    ).toBeNull();
  });
});

describe("uploadFile", () => {
  test("runs the external upload flow and completes it in the thread", async () => {
    const { calls, client } = recorder([
      jsonResponse({
        file_id: "F0NEW",
        ok: true,
        upload_url: "https://files.slack.com/upload/F0NEW",
      }),
      new Response("", { status: 200 }),
      jsonResponse({ ok: true }),
    ]);

    const uploaded = await client.uploadFile({
      channel: "C0OPSCHAN",
      data: new TextEncoder().encode("hello").buffer,
      filename: "note.txt",
      threadTs: "1787200000.000100",
    });

    expect(uploaded).toBe(true);
    expect(callAt(calls, 0).url).toBe(
      "https://slack.com/api/files.getUploadURLExternal?filename=note.txt&length=5"
    );
    expect(callAt(calls, 1).url).toBe("https://files.slack.com/upload/F0NEW");
    expect(JSON.parse(callAt(calls, 2).body)).toEqual({
      channel_id: "C0OPSCHAN",
      files: [{ id: "F0NEW", title: "note.txt" }],
      thread_ts: "1787200000.000100",
    });
  });

  test("stops when Slack will not hand out an upload URL", async () => {
    const { calls, client } = recorder([
      jsonResponse({ error: "invalid_auth", ok: false }),
    ]);

    expect(
      await client.uploadFile({
        channel: "C0OPSCHAN",
        data: new ArrayBuffer(4),
        filename: "note.txt",
      })
    ).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

describe("conversationsInfo", () => {
  test("reports the channel and whether the bot is in it", async () => {
    const { calls, client } = recorder([
      jsonResponse({
        channel: { id: "C0OPSCHAN", is_member: false, name: "ops" },
        ok: true,
      }),
    ]);

    expect(await client.conversationsInfo("C0OPSCHAN")).toEqual({
      id: "C0OPSCHAN",
      isMember: false,
      name: "ops",
    });
    // A documented read method: GET with query arguments, not a JSON body.
    expect(callAt(calls, 0).url).toBe(
      "https://slack.com/api/conversations.info?channel=C0OPSCHAN"
    );
  });

  test("returns null for a channel Slack will not show us", async () => {
    const { client } = recorder([
      jsonResponse({ error: "channel_not_found", ok: false }),
    ]);

    expect(await client.conversationsInfo("C0GONE")).toBeNull();
  });
});

describe("usersInfo", () => {
  test("carries the profile email when the scope allows one", async () => {
    const { client } = recorder([
      jsonResponse({
        ok: true,
        user: {
          name: "dominik",
          profile: { display_name: "Dominik", email: "dominik@example.com" },
        },
      }),
    ]);

    expect(await client.usersInfo("U0DOM")).toEqual({
      displayName: "Dominik",
      email: "dominik@example.com",
    });
  });

  test("prefers the display name, then the real name, then the handle", async () => {
    const { calls, client } = recorder([
      jsonResponse({
        ok: true,
        user: {
          name: "alice",
          profile: { display_name: "", real_name: "Alice A" },
        },
      }),
    ]);

    expect(await client.usersInfo("U1ALICE")).toEqual({
      displayName: "Alice A",
      email: null,
    });
    expect(callAt(calls, 0).url).toBe(
      "https://slack.com/api/users.info?user=U1ALICE"
    );
  });
});
