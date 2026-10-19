import { expect, test } from "bun:test";
import { createSlackClient, type SlackFetch } from "./client.ts";

const TOKEN = "xoxb-test-token-123";

interface Recorded {
  init: RequestInit;
  url: string;
}

/** A fake fetch that records every call and answers with `respond`. */
function fakeFetch(
  respond: (url: string, init: RequestInit) => Response | Promise<Response>
): { calls: Recorded[]; fetch: SlackFetch } {
  const calls: Recorded[] = [];
  const fetch: SlackFetch = (url, init) => {
    calls.push({ init, url });
    return Promise.resolve(respond(url, init));
  };
  return { calls, fetch };
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
    status,
  });
}

function firstCall(calls: Recorded[]): Recorded {
  const [call] = calls;
  if (call === undefined) {
    throw new Error("fetch was not called");
  }
  return call;
}

function sentBody(call: Recorded): Record<string, unknown> {
  const parsed: unknown = JSON.parse(String(call.init.body));
  return parsed as Record<string, unknown>;
}

test("postMessage returns the ts of a posted message", async () => {
  const { calls, fetch } = fakeFetch(() =>
    jsonResponse({ ok: true, ts: "1700000000.000100" })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.postMessage({ channel: "C1", text: "hello" });

  expect(result).toEqual({ kind: "ok", ts: "1700000000.000100" });
  expect(firstCall(calls).url).toBe("https://slack.com/api/chat.postMessage");
  expect(firstCall(calls).init.method).toBe("POST");
});

test("postMessage maps a ratelimited body to rate_limited with Retry-After", async () => {
  const { fetch } = fakeFetch(() =>
    jsonResponse({ error: "ratelimited", ok: false }, 200, {
      "Retry-After": "7",
    })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.postMessage({ channel: "C1", text: "hello" });

  expect(result).toEqual({ kind: "rate_limited", retryAfterSeconds: 7 });
});

test("postMessage treats a 429 status as rate_limited", async () => {
  const { fetch } = fakeFetch(() =>
    jsonResponse({ ok: false }, 429, { "Retry-After": "7" })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.postMessage({ channel: "C1", text: "hello" });

  expect(result).toEqual({ kind: "rate_limited", retryAfterSeconds: 7 });
});

test("postMessage classifies invalid_auth as config", async () => {
  const { fetch } = fakeFetch(() =>
    jsonResponse({ error: "invalid_auth", ok: false })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.postMessage({ channel: "C1", text: "hello" });

  expect(result).toEqual({ error: "invalid_auth", kind: "config" });
});

test("postMessage classifies channel_not_found as config", async () => {
  const { fetch } = fakeFetch(() =>
    jsonResponse({ error: "channel_not_found", ok: false })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.postMessage({ channel: "C1", text: "hello" });

  expect(result).toEqual({ error: "channel_not_found", kind: "config" });
});

test("postMessage classifies msg_too_long as rejected", async () => {
  const { fetch } = fakeFetch(() =>
    jsonResponse({ error: "msg_too_long", ok: false })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.postMessage({ channel: "C1", text: "hello" });

  expect(result).toEqual({ error: "msg_too_long", kind: "rejected" });
});

test("postMessage treats a 5xx status as transient", async () => {
  const { fetch } = fakeFetch(() => new Response("oops", { status: 503 }));
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.postMessage({ channel: "C1", text: "hello" });

  expect(result).toEqual({ error: "http_503", kind: "transient" });
});

test("postMessage treats a thrown fetch as transient and keeps the token out", async () => {
  const fetch: SlackFetch = () => {
    throw new TypeError(`socket closed while sending ${TOKEN}`);
  };
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.postMessage({ channel: "C1", text: "hello" });

  expect(result.kind).toBe("transient");
  expect(JSON.stringify(result)).not.toContain(TOKEN);
});

test("postMessage escapes mentions, links and ampersands so agent text cannot ping or phish", async () => {
  const { calls, fetch } = fakeFetch(() => jsonResponse({ ok: true, ts: "1" }));
  const client = createSlackClient({ fetch, token: TOKEN });

  await client.postMessage({
    channel: "C1",
    text: "<!channel> <!here> <!everyone> <@U123> <#C1> <https://example.com|label> a & b",
  });

  expect(sentBody(firstCall(calls)).text).toBe(
    "&lt;!channel&gt; &lt;!here&gt; &lt;!everyone&gt; &lt;@U123&gt; &lt;#C1&gt; &lt;https://example.com|label&gt; a &amp; b"
  );
});

test("postMessage keeps well-formed user mentions and channel links but escapes other control syntax", async () => {
  const { calls, fetch } = fakeFetch(() => jsonResponse({ ok: true, ts: "1" }));
  const client = createSlackClient({ fetch, token: TOKEN });

  await client.postMessage({
    channel: "C1",
    text: "ask <@U0ANN1234> in <#C0GENERAL1> now <!channel> <@U0ANN1234|label> <https://evil.test|label> a & b",
  });

  expect(sentBody(firstCall(calls)).text).toBe(
    "ask <@U0ANN1234> in <#C0GENERAL1> now &lt;!channel&gt; &lt;@U0ANN1234|label&gt; &lt;https://evil.test|label&gt; a &amp; b"
  );
});

test("postMessage escapes a lowercase user id that is not a well-formed mention", async () => {
  const { calls, fetch } = fakeFetch(() => jsonResponse({ ok: true, ts: "1" }));
  const client = createSlackClient({ fetch, token: TOKEN });

  await client.postMessage({ channel: "C1", text: "<@u0ann1234>" });

  expect(sentBody(firstCall(calls)).text).toBe("&lt;@u0ann1234&gt;");
});

test("postEphemeral still escapes a well-formed user mention", async () => {
  const { calls, fetch } = fakeFetch(() => jsonResponse({ ok: true }));
  const client = createSlackClient({ fetch, token: TOKEN });

  await client.postEphemeral({
    channel: "C1",
    text: "<@U0ANN1234> <#C0GENERAL1>",
    user: "U9",
  });

  expect(sentBody(firstCall(calls)).text).toBe(
    "&lt;@U0ANN1234&gt; &lt;#C0GENERAL1&gt;"
  );
});

test("postMessage sends thread_ts and turns off unfurling", async () => {
  const { calls, fetch } = fakeFetch(() => jsonResponse({ ok: true, ts: "1" }));
  const client = createSlackClient({ fetch, token: TOKEN });

  await client.postMessage({ channel: "C1", text: "hi", threadTs: "1.2" });

  const body = sentBody(firstCall(calls));
  expect(body.thread_ts).toBe("1.2");
  expect(body.unfurl_links).toBe(false);
  expect(body.unfurl_media).toBe(false);
  expect(body.channel).toBe("C1");
});

test("postEphemeral escapes the text and sends user and thread_ts", async () => {
  const { calls, fetch } = fakeFetch(() =>
    jsonResponse({ message_ts: "2.3", ok: true })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.postEphemeral({
    channel: "C1",
    text: "<!here> ping <@U1>",
    threadTs: "1.2",
    user: "U9",
  });

  expect(result).toEqual({ kind: "ok" });
  expect(firstCall(calls).url).toBe("https://slack.com/api/chat.postEphemeral");
  const body = sentBody(firstCall(calls));
  expect(body.user).toBe("U9");
  expect(body.thread_ts).toBe("1.2");
  expect(body.text).toBe("&lt;!here&gt; ping &lt;@U1&gt;");
});

test("postEphemeral classifies a Slack error body", async () => {
  const { fetch } = fakeFetch(() =>
    jsonResponse({ error: "user_not_in_channel", ok: false })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.postEphemeral({
    channel: "C1",
    text: "hi",
    user: "U9",
  });

  expect(result).toEqual({ error: "user_not_in_channel", kind: "rejected" });
});

test("setStatus posts channel_id, thread_ts and status with the bearer token", async () => {
  const { calls, fetch } = fakeFetch(() => jsonResponse({ ok: true }));
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.setStatus({
    channel: "C1",
    status: "is thinking…",
    threadTs: "1.2",
  });

  expect(result).toEqual({ kind: "ok" });
  expect(firstCall(calls).url).toBe(
    "https://slack.com/api/assistant.threads.setStatus"
  );
  expect(firstCall(calls).init.method).toBe("POST");
  expect(new Headers(firstCall(calls).init.headers).get("authorization")).toBe(
    `Bearer ${TOKEN}`
  );
  expect(sentBody(firstCall(calls))).toEqual({
    channel_id: "C1",
    status: "is thinking…",
    thread_ts: "1.2",
  });
});

test("setStatus sends an empty status to clear the status", async () => {
  const { calls, fetch } = fakeFetch(() => jsonResponse({ ok: true }));
  const client = createSlackClient({ fetch, token: TOKEN });

  await client.setStatus({ channel: "C1", status: "", threadTs: "1.2" });

  expect(sentBody(firstCall(calls)).status).toBe("");
});

test("setStatus classifies missing_scope as config", async () => {
  const { fetch } = fakeFetch(() =>
    jsonResponse({ error: "missing_scope", ok: false })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.setStatus({
    channel: "C1",
    status: "x",
    threadTs: "1.2",
  });

  expect(result).toEqual({ error: "missing_scope", kind: "config" });
});

test("setStatus classifies method_not_supported_for_channel_type as rejected", async () => {
  const { fetch } = fakeFetch(() =>
    jsonResponse({
      error: "method_not_supported_for_channel_type",
      ok: false,
    })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.setStatus({
    channel: "C1",
    status: "x",
    threadTs: "1.2",
  });

  expect(result).toEqual({
    error: "method_not_supported_for_channel_type",
    kind: "rejected",
  });
});

test("setStatus maps a ratelimited body to rate_limited", async () => {
  const { fetch } = fakeFetch(() =>
    jsonResponse({ error: "ratelimited", ok: false }, 200, {
      "Retry-After": "7",
    })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.setStatus({
    channel: "C1",
    status: "x",
    threadTs: "1.2",
  });

  expect(result).toEqual({ kind: "rate_limited", retryAfterSeconds: 7 });
});

test("userEmail returns the profile email", async () => {
  const { calls, fetch } = fakeFetch(() =>
    jsonResponse({ ok: true, user: { profile: { email: "a@example.com" } } })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.userEmail("U1");

  expect(result).toEqual({ email: "a@example.com", kind: "ok" });
  const url = new URL(firstCall(calls).url);
  expect(url.origin + url.pathname).toBe("https://slack.com/api/users.info");
  expect(url.searchParams.get("user")).toBe("U1");
  expect(firstCall(calls).init.method).toBe("GET");
  expect(new Headers(firstCall(calls).init.headers).get("authorization")).toBe(
    `Bearer ${TOKEN}`
  );
});

test("userEmail returns null when the user has no email", async () => {
  const { fetch } = fakeFetch(() =>
    jsonResponse({ ok: true, user: { profile: {} } })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.userEmail("U1");

  expect(result).toEqual({ email: null, kind: "ok" });
});

test("userName returns the display name and requests users.info", async () => {
  const { calls, fetch } = fakeFetch(() =>
    jsonResponse({
      ok: true,
      user: {
        name: "ada",
        profile: { display_name: "Ada D", real_name: "Ada Duke" },
        real_name: "Ada Duke Top",
      },
    })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.userName("U1");

  expect(result).toEqual({
    aliases: ["Ada D", "Ada Duke", "Ada Duke Top", "ada"],
    kind: "ok",
    name: "Ada D",
  });
  const url = new URL(firstCall(calls).url);
  expect(url.origin + url.pathname).toBe("https://slack.com/api/users.info");
  expect(url.searchParams.get("user")).toBe("U1");
  expect(firstCall(calls).init.method).toBe("GET");
  expect(new Headers(firstCall(calls).init.headers).get("authorization")).toBe(
    `Bearer ${TOKEN}`
  );
});

test("userName falls back to real_name when the display name is empty", async () => {
  const { fetch } = fakeFetch(() =>
    jsonResponse({
      ok: true,
      user: {
        name: "ada",
        profile: { display_name: "", real_name: "Ada Duke" },
        real_name: "Other",
      },
    })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.userName("U1");

  expect(result).toEqual({
    aliases: ["Ada Duke", "Other", "ada"],
    kind: "ok",
    name: "Ada Duke",
  });
});

test("userName collapses names that repeat across fields", async () => {
  const { fetch } = fakeFetch(() =>
    jsonResponse({
      ok: true,
      user: {
        name: "ada",
        profile: { display_name: "ada", real_name: "Ada Duke" },
        real_name: "Ada Duke",
      },
    })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.userName("U1");

  expect(result).toEqual({
    aliases: ["ada", "Ada Duke"],
    kind: "ok",
    name: "ada",
  });
});

test("userName returns null and no aliases when the user has no name", async () => {
  const { fetch } = fakeFetch(() =>
    jsonResponse({ ok: true, user: { profile: {} } })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.userName("U1");

  expect(result).toEqual({ aliases: [], kind: "ok", name: null });
});

test("channelName returns the channel name and requests conversations.info", async () => {
  const { calls, fetch } = fakeFetch(() =>
    jsonResponse({ channel: { id: "C1", name: "general" }, ok: true })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.channelName("C1");

  expect(result).toEqual({ kind: "ok", name: "general" });
  const url = new URL(firstCall(calls).url);
  expect(url.origin + url.pathname).toBe(
    "https://slack.com/api/conversations.info"
  );
  expect(url.searchParams.get("channel")).toBe("C1");
  expect(firstCall(calls).init.method).toBe("GET");
  expect(new Headers(firstCall(calls).init.headers).get("authorization")).toBe(
    `Bearer ${TOKEN}`
  );
});

test("channelName returns null when the channel has no name", async () => {
  const { fetch } = fakeFetch(() =>
    jsonResponse({ channel: { id: "D1" }, ok: true })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.channelName("D1");

  expect(result).toEqual({ kind: "ok", name: null });
});

test("channelName classifies missing_scope as config", async () => {
  const { fetch } = fakeFetch(() =>
    jsonResponse({ error: "missing_scope", ok: false })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.channelName("C1");

  expect(result).toEqual({ error: "missing_scope", kind: "config" });
});

test("downloadFile returns the bytes with the bearer token and no redirects", async () => {
  const { calls, fetch } = fakeFetch(
    () =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/png" },
      })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.downloadFile(
    "https://files.slack.com/files-pri/T1-F1/a.png",
    100
  );

  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") {
    return;
  }
  expect(Array.from(result.bytes)).toEqual([1, 2, 3]);
  expect(result.contentType).toBe("image/png");
  expect(firstCall(calls).init.redirect).toBe("error");
  expect(new Headers(firstCall(calls).init.headers).get("authorization")).toBe(
    `Bearer ${TOKEN}`
  );
});

test("downloadFile reports too_large from Content-Length without reading the body", async () => {
  const { fetch } = fakeFetch(
    () =>
      new Response(new Uint8Array(50), {
        headers: { "content-length": "50" },
      })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.downloadFile(
    "https://files.slack.com/files-pri/T1-F1/a.png",
    10
  );

  expect(result).toEqual({ kind: "too_large" });
});

test("downloadFile stops reading a streamed body once it passes the cap", async () => {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      if (pulled > 100) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(10));
    },
  });
  const { fetch } = fakeFetch(
    () =>
      new Response(stream, {
        headers: { "content-type": "application/octet-stream" },
      })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.downloadFile(
    "https://files.slack.com/files-pri/T1-F1/big.bin",
    25
  );

  expect(result).toEqual({ kind: "too_large" });
  expect(pulled).toBeLessThan(20);
});

test("downloadFile rejects a host outside Slack without calling fetch", async () => {
  const { calls, fetch } = fakeFetch(() => new Response("never"));
  const client = createSlackClient({ fetch, token: TOKEN });

  const urls = [
    "https://evil.example.com/files-pri/a.png",
    "http://files.slack.com/files-pri/a.png",
    "https://files.slack.com.evil.example/a.png",
    "https://evilslack-files.com/a.png",
    "not a url",
  ];
  const results = await Promise.all(
    urls.map((url) => client.downloadFile(url, 100))
  );
  expect(results).toEqual(
    urls.map(() => ({ error: "bad_host", kind: "rejected" }))
  );
  expect(calls).toHaveLength(0);
});

test("downloadFile accepts a .slack-files.com host", async () => {
  const { calls, fetch } = fakeFetch(() => new Response(new Uint8Array(1)));
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.downloadFile(
    "https://team.slack-files.com/a.png",
    100
  );

  expect(result.kind).toBe("ok");
  expect(calls).toHaveLength(1);
});

test("downloadFile treats a 404 as rejected", async () => {
  const { fetch } = fakeFetch(() => new Response("missing", { status: 404 }));
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.downloadFile(
    "https://files.slack.com/files-pri/T1-F1/gone.png",
    100
  );

  expect(result).toEqual({ error: "http_404", kind: "rejected" });
});

test("downloadFile rejects an HTML login page", async () => {
  const { fetch } = fakeFetch(
    () =>
      new Response("<html>sign in</html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.downloadFile(
    "https://files.slack.com/files-pri/T1-F1/a.png",
    100
  );

  expect(result).toEqual({ error: "html_response", kind: "rejected" });
});

const UPLOAD_URL = "https://files.slack.com/upload/v1/abc123";

/** Answers the three upload steps. `upload` replies to the raw POST to the upload URL. */
function uploadFetch(options: {
  start?: Response;
  upload?: Response;
  complete?: Response;
}): { calls: Recorded[]; fetch: SlackFetch } {
  return fakeFetch((url) => {
    if (url.startsWith("https://slack.com/api/files.getUploadURLExternal")) {
      return (
        options.start ??
        jsonResponse({ file_id: "F1", ok: true, upload_url: UPLOAD_URL })
      );
    }
    if (url === UPLOAD_URL) {
      return options.upload ?? new Response("OK - 3", { status: 200 });
    }
    return (
      options.complete ?? jsonResponse({ files: [{ id: "F1" }], ok: true })
    );
  });
}

test("uploadFile runs the three-step flow and returns the file id", async () => {
  const { calls, fetch } = uploadFetch({});
  const client = createSlackClient({ fetch, token: TOKEN });
  const bytes = new Uint8Array([1, 2, 3]);

  const result = await client.uploadFile({
    bytes,
    channel: "C1",
    filename: "report.csv",
    threadTs: "1.2",
  });

  expect(result).toEqual({ fileId: "F1", kind: "ok" });
  expect(calls.map((call) => call.init.method)).toEqual([
    "GET",
    "POST",
    "POST",
  ]);
  expect(calls.map((call) => call.url.split("?")[0])).toEqual([
    "https://slack.com/api/files.getUploadURLExternal",
    UPLOAD_URL,
    "https://slack.com/api/files.completeUploadExternal",
  ]);
  const start = new URL(firstCall(calls).url);
  expect(start.searchParams.get("filename")).toBe("report.csv");
  expect(start.searchParams.get("length")).toBe("3");
  expect(new Headers(firstCall(calls).init.headers).get("authorization")).toBe(
    `Bearer ${TOKEN}`
  );

  const upload = firstCall(calls.slice(1));
  expect(upload.init.body).toEqual(bytes);
  expect(new Headers(upload.init.headers).get("content-type")).toBe(
    "application/octet-stream"
  );
  expect(new Headers(upload.init.headers).get("authorization")).toBeNull();
  expect(upload.init.redirect).toBe("error");

  expect(sentBody(firstCall(calls.slice(2)))).toEqual({
    channel_id: "C1",
    files: [{ id: "F1", title: "report.csv" }],
    thread_ts: "1.2",
  });
});

test("uploadFile leaves thread_ts out of the complete body when there is no thread", async () => {
  const { calls, fetch } = uploadFetch({});
  const client = createSlackClient({ fetch, token: TOKEN });

  await client.uploadFile({
    bytes: new Uint8Array([1]),
    channel: "C1",
    filename: "a.txt",
  });

  expect(Object.keys(sentBody(firstCall(calls.slice(2))))).not.toContain(
    "thread_ts"
  );
});

test("uploadFile sends nothing to an upload URL off Slack's file hosts", async () => {
  const { calls, fetch } = uploadFetch({
    start: jsonResponse({
      file_id: "F1",
      ok: true,
      upload_url: "https://evil.example.com/upload",
    }),
  });
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.uploadFile({
    bytes: new Uint8Array([1]),
    channel: "C1",
    filename: "a.txt",
  });

  expect(result).toEqual({ error: "bad_host", kind: "rejected" });
  expect(calls).toHaveLength(1);
});

test("uploadFile returns transient on a 500 from the upload and skips complete", async () => {
  const { calls, fetch } = uploadFetch({
    upload: new Response("oops", { status: 500 }),
  });
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.uploadFile({
    bytes: new Uint8Array([1]),
    channel: "C1",
    filename: "a.txt",
  });

  expect(result).toEqual({ error: "http_500", kind: "transient" });
  expect(calls.map((call) => call.url)).not.toContain(
    "https://slack.com/api/files.completeUploadExternal"
  );
});

test("uploadFile returns the error when files.completeUploadExternal fails", async () => {
  const { fetch } = uploadFetch({
    complete: jsonResponse({ error: "channel_not_found", ok: false }),
  });
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.uploadFile({
    bytes: new Uint8Array([1]),
    channel: "C1",
    filename: "a.txt",
  });

  expect(result).toEqual({ error: "channel_not_found", kind: "config" });
});

test("uploadFile returns rejected on a 404 from the upload", async () => {
  const { fetch } = uploadFetch({
    upload: new Response("gone", { status: 404 }),
  });
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.uploadFile({
    bytes: new Uint8Array([1]),
    channel: "C1",
    filename: "a.txt",
  });

  expect(result).toEqual({ error: "http_404", kind: "rejected" });
});

test("uploadFile returns rate_limited when getUploadURLExternal is throttled", async () => {
  const { fetch } = uploadFetch({
    start: jsonResponse({ error: "ratelimited", ok: false }, 200, {
      "Retry-After": "5",
    }),
  });
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.uploadFile({
    bytes: new Uint8Array([1]),
    channel: "C1",
    filename: "a.txt",
  });

  expect(result).toEqual({ kind: "rate_limited", retryAfterSeconds: 5 });
});

test("uploadFile classifies missing_scope as config", async () => {
  const { calls, fetch } = uploadFetch({
    start: jsonResponse({ error: "missing_scope", ok: false }),
  });
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.uploadFile({
    bytes: new Uint8Array([1]),
    channel: "C1",
    filename: "a.txt",
  });

  expect(result).toEqual({ error: "missing_scope", kind: "config" });
  expect(calls).toHaveLength(1);
});

test("uploadFile rejects a getUploadURLExternal answer without a file id", async () => {
  const { calls, fetch } = uploadFetch({
    start: jsonResponse({ ok: true, upload_url: UPLOAD_URL }),
  });
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.uploadFile({
    bytes: new Uint8Array([1]),
    channel: "C1",
    filename: "a.txt",
  });

  expect(result.kind).toBe("rejected");
  expect(calls).toHaveLength(1);
});

test("authTest returns the team, user and bot ids of a bot token", async () => {
  const { calls, fetch } = fakeFetch(() =>
    jsonResponse({
      bot_id: "B1",
      ok: true,
      team_id: "T1",
      user_id: "U1",
    })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.authTest();

  expect(result).toEqual({
    botId: "B1",
    kind: "ok",
    teamId: "T1",
    userId: "U1",
  });
  const url = new URL(firstCall(calls).url);
  expect(url.origin + url.pathname).toBe("https://slack.com/api/auth.test");
  expect(firstCall(calls).init.method).toBe("GET");
  expect(new Headers(firstCall(calls).init.headers).get("authorization")).toBe(
    `Bearer ${TOKEN}`
  );
  expect(JSON.stringify(result)).not.toContain(TOKEN);
});

test("authTest returns a null botId when the token has no bot", async () => {
  const { fetch } = fakeFetch(() =>
    jsonResponse({ ok: true, team_id: "T1", user_id: "U1" })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.authTest();

  expect(result).toEqual({
    botId: null,
    kind: "ok",
    teamId: "T1",
    userId: "U1",
  });
});

test("authTest classifies invalid_auth as config", async () => {
  const { fetch } = fakeFetch(() =>
    jsonResponse({ error: "invalid_auth", ok: false })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.authTest();

  expect(result).toEqual({ error: "invalid_auth", kind: "config" });
});

test("authTest rejects a response that has no team_id", async () => {
  const { fetch } = fakeFetch(() => jsonResponse({ ok: true, user_id: "U1" }));
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.authTest();

  expect(result.kind).toBe("rejected");
});

test("botInfo sends the bot id in the query and returns the app id", async () => {
  const { calls, fetch } = fakeFetch(() =>
    jsonResponse({ bot: { app_id: "A1", id: "B1" }, ok: true })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.botInfo("B1");

  expect(result).toEqual({ appId: "A1", kind: "ok" });
  const url = new URL(firstCall(calls).url);
  expect(url.origin + url.pathname).toBe("https://slack.com/api/bots.info");
  expect(url.searchParams.get("bot")).toBe("B1");
  expect(firstCall(calls).init.method).toBe("GET");
  expect(new Headers(firstCall(calls).init.headers).get("authorization")).toBe(
    `Bearer ${TOKEN}`
  );
});

test("botInfo rejects a bot with no app_id", async () => {
  const { fetch } = fakeFetch(() => jsonResponse({ bot: {}, ok: true }));
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.botInfo("B1");

  expect(result.kind).toBe("rejected");
});

test("listChannels requests users.conversations and parses public and private channels", async () => {
  const { calls, fetch } = fakeFetch(() =>
    jsonResponse({
      channels: [
        { id: "C1", is_private: false, name: "general" },
        { id: "G1", is_private: true, name: "secret" },
      ],
      ok: true,
      response_metadata: { next_cursor: "" },
    })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.listChannels();

  expect(result).toEqual({
    channels: [
      { id: "C1", isPrivate: false, name: "general" },
      { id: "G1", isPrivate: true, name: "secret" },
    ],
    kind: "ok",
  });
  expect(calls).toHaveLength(1);
  const url = new URL(firstCall(calls).url);
  expect(url.origin + url.pathname).toBe(
    "https://slack.com/api/users.conversations"
  );
  expect(url.searchParams.get("types")).toBe("public_channel,private_channel");
  expect(url.searchParams.get("exclude_archived")).toBe("true");
  expect(url.searchParams.get("limit")).toBe("200");
  expect(url.searchParams.has("cursor")).toBe(false);
  expect(firstCall(calls).init.method).toBe("GET");
  expect(new Headers(firstCall(calls).init.headers).get("authorization")).toBe(
    `Bearer ${TOKEN}`
  );
});

test("listChannels follows next_cursor across two pages", async () => {
  const { calls, fetch } = fakeFetch((url) => {
    if (new URL(url).searchParams.get("cursor") === "page2") {
      return jsonResponse({
        channels: [{ id: "C2", is_private: false, name: "random" }],
        ok: true,
        response_metadata: { next_cursor: "" },
      });
    }
    return jsonResponse({
      channels: [{ id: "C1", is_private: false, name: "general" }],
      ok: true,
      response_metadata: { next_cursor: "page2" },
    });
  });
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.listChannels();

  expect(result).toEqual({
    channels: [
      { id: "C1", isPrivate: false, name: "general" },
      { id: "C2", isPrivate: false, name: "random" },
    ],
    kind: "ok",
  });
  expect(calls).toHaveLength(2);
  expect(
    new URL(firstCall(calls.slice(1)).url).searchParams.get("cursor")
  ).toBe("page2");
});

test("listChannels stops after five pages even when Slack keeps returning a cursor", async () => {
  const { calls, fetch } = fakeFetch(() =>
    jsonResponse({
      channels: [{ id: "C1", is_private: false, name: "general" }],
      ok: true,
      response_metadata: { next_cursor: "more" },
    })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.listChannels();

  expect(calls).toHaveLength(5);
  expect(result).toEqual({
    channels: Array.from({ length: 5 }, () => ({
      id: "C1",
      isPrivate: false,
      name: "general",
    })),
    kind: "ok",
  });
});

test("listChannels returns the error of a failing page as it is", async () => {
  let page = 0;
  const { fetch } = fakeFetch(() => {
    page += 1;
    if (page === 1) {
      return jsonResponse({
        channels: [{ id: "C1", is_private: false, name: "general" }],
        ok: true,
        response_metadata: { next_cursor: "page2" },
      });
    }
    return jsonResponse({ error: "ratelimited", ok: false }, 200, {
      "Retry-After": "3",
    });
  });
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.listChannels();

  expect(result).toEqual({ kind: "rate_limited", retryAfterSeconds: 3 });
});

test("listChannels classifies missing_scope as config", async () => {
  const { fetch } = fakeFetch(() =>
    jsonResponse({ error: "missing_scope", ok: false })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.listChannels();

  expect(result).toEqual({ error: "missing_scope", kind: "config" });
});

test("listChannels skips entries without an id or a name", async () => {
  const { fetch } = fakeFetch(() =>
    jsonResponse({
      channels: [
        { id: "C1", is_private: false, name: "general" },
        { is_private: false, name: "no-id" },
        { id: "", is_private: false, name: "empty-id" },
        { id: "C3", is_private: false },
        { id: "C4", is_private: false, name: "" },
        "not an object",
        null,
      ],
      ok: true,
      response_metadata: { next_cursor: "" },
    })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.listChannels();

  expect(result).toEqual({
    channels: [{ id: "C1", isPrivate: false, name: "general" }],
    kind: "ok",
  });
});

test("openDm posts the user to conversations.open and returns the DM channel id", async () => {
  const { calls, fetch } = fakeFetch(() =>
    jsonResponse({ channel: { id: "D1" }, ok: true })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.openDm("U1");

  expect(result).toEqual({ channelId: "D1", kind: "ok" });
  expect(firstCall(calls).url).toBe("https://slack.com/api/conversations.open");
  expect(firstCall(calls).init.method).toBe("POST");
  expect(sentBody(firstCall(calls))).toEqual({ users: "U1" });
  expect(new Headers(firstCall(calls).init.headers).get("authorization")).toBe(
    `Bearer ${TOKEN}`
  );
});

test("openDm rejects a response with no channel id", async () => {
  const { fetch } = fakeFetch(() => jsonResponse({ channel: {}, ok: true }));
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.openDm("U1");

  expect(result).toEqual({ error: "no_error", kind: "rejected" });
});

test("openDm classifies missing_scope as config", async () => {
  const { fetch } = fakeFetch(() =>
    jsonResponse({ error: "missing_scope", ok: false })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.openDm("U1");

  expect(result).toEqual({ error: "missing_scope", kind: "config" });
});

test("permalink requests chat.getPermalink with channel and message_ts and returns the link", async () => {
  const { calls, fetch } = fakeFetch(() =>
    jsonResponse({
      channel: "C1",
      ok: true,
      permalink: "https://team.slack.com/archives/C1/p1700000000000100",
    })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.permalink("C1", "1700000000.000100");

  expect(result).toEqual({
    kind: "ok",
    permalink: "https://team.slack.com/archives/C1/p1700000000000100",
  });
  const url = new URL(firstCall(calls).url);
  expect(url.origin + url.pathname).toBe(
    "https://slack.com/api/chat.getPermalink"
  );
  expect(url.searchParams.get("channel")).toBe("C1");
  expect(url.searchParams.get("message_ts")).toBe("1700000000.000100");
  expect(firstCall(calls).init.method).toBe("GET");
  expect(new Headers(firstCall(calls).init.headers).get("authorization")).toBe(
    `Bearer ${TOKEN}`
  );
});

test("permalink rejects a response with no permalink", async () => {
  const { fetch } = fakeFetch(() => jsonResponse({ ok: true }));
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.permalink("C1", "1.2");

  expect(result).toEqual({ error: "no_error", kind: "rejected" });
});

test("history requests conversations.history with the channel and limit as a string", async () => {
  const { calls, fetch } = fakeFetch(() =>
    jsonResponse({ messages: [], ok: true })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.history({ channel: "C1", limit: 50 });

  expect(result).toEqual({ kind: "ok", messages: [], nextCursor: null });
  const url = new URL(firstCall(calls).url);
  expect(url.origin + url.pathname).toBe(
    "https://slack.com/api/conversations.history"
  );
  expect(firstCall(calls).init.method).toBe("GET");
  expect(url.searchParams.get("channel")).toBe("C1");
  expect(url.searchParams.get("limit")).toBe("50");
  expect(url.searchParams.has("cursor")).toBe(false);
  expect(url.searchParams.has("latest")).toBe(false);
  expect(url.searchParams.has("oldest")).toBe(false);
});

test("history sends cursor, latest and oldest when given", async () => {
  const { calls, fetch } = fakeFetch(() =>
    jsonResponse({ messages: [], ok: true })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  await client.history({
    channel: "C1",
    cursor: "dXNlcjpU",
    latest: "1700000900.000100",
    limit: 20,
    oldest: "1700000000.000100",
  });

  const url = new URL(firstCall(calls).url);
  expect(url.searchParams.get("cursor")).toBe("dXNlcjpU");
  expect(url.searchParams.get("latest")).toBe("1700000900.000100");
  expect(url.searchParams.get("oldest")).toBe("1700000000.000100");
  expect(url.searchParams.get("limit")).toBe("20");
});

test("history maps messages in Slack's order and skips an entry without a ts", async () => {
  const { fetch } = fakeFetch(() =>
    jsonResponse({
      messages: [
        {
          bot_id: "B1",
          text: "from a bot",
          thread_ts: "1700000000.000100",
          ts: "1700000300.000100",
        },
        { text: "no ts here", user: "U9" },
        { text: "from a person", ts: "1700000200.000100", user: "U2" },
        { text: 42, ts: "1700000100.000100" },
      ],
      ok: true,
    })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.history({ channel: "C1", limit: 10 });

  expect(result).toEqual({
    kind: "ok",
    messages: [
      {
        botId: "B1",
        text: "from a bot",
        threadTs: "1700000000.000100",
        ts: "1700000300.000100",
        user: null,
      },
      {
        botId: null,
        text: "from a person",
        threadTs: null,
        ts: "1700000200.000100",
        user: "U2",
      },
      {
        botId: null,
        text: "",
        threadTs: null,
        ts: "1700000100.000100",
        user: null,
      },
    ],
    nextCursor: null,
  });
});

test("history returns next_cursor when Slack gives one", async () => {
  const { fetch } = fakeFetch(() =>
    jsonResponse({
      messages: [],
      ok: true,
      response_metadata: { next_cursor: "bmV4dA==" },
    })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.history({ channel: "C1", limit: 10 });

  expect(result).toEqual({ kind: "ok", messages: [], nextCursor: "bmV4dA==" });
});

test("history returns a null nextCursor when next_cursor is empty", async () => {
  const { fetch } = fakeFetch(() =>
    jsonResponse({
      messages: [],
      ok: true,
      response_metadata: { next_cursor: "" },
    })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.history({ channel: "C1", limit: 10 });

  expect(result).toEqual({ kind: "ok", messages: [], nextCursor: null });
});

test("history classifies not_in_channel as config", async () => {
  const { fetch } = fakeFetch(() =>
    jsonResponse({ error: "not_in_channel", ok: false })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.history({ channel: "C1", limit: 10 });

  expect(result).toEqual({ error: "not_in_channel", kind: "config" });
});

test("history maps a ratelimited body to rate_limited", async () => {
  const { fetch } = fakeFetch(() =>
    jsonResponse({ error: "ratelimited", ok: false }, 200, {
      "Retry-After": "12",
    })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.history({ channel: "C1", limit: 10 });

  expect(result).toEqual({ kind: "rate_limited", retryAfterSeconds: 12 });
});

test("history rejects a body without messages", async () => {
  const { fetch } = fakeFetch(() => jsonResponse({ ok: true }));
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.history({ channel: "C1", limit: 10 });

  expect(result).toEqual({ error: "no_error", kind: "rejected" });
});

test("replies requests conversations.replies with ts and the window parameters", async () => {
  const { calls, fetch } = fakeFetch(() =>
    jsonResponse({ messages: [], ok: true })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.replies({
    channel: "C1",
    cursor: "cur",
    latest: "1700000900.000100",
    limit: 5,
    oldest: "1700000000.000100",
    ts: "1700000000.000100",
  });

  expect(result).toEqual({ kind: "ok", messages: [], nextCursor: null });
  const url = new URL(firstCall(calls).url);
  expect(url.origin + url.pathname).toBe(
    "https://slack.com/api/conversations.replies"
  );
  expect(firstCall(calls).init.method).toBe("GET");
  expect(url.searchParams.get("channel")).toBe("C1");
  expect(url.searchParams.get("ts")).toBe("1700000000.000100");
  expect(url.searchParams.get("limit")).toBe("5");
  expect(url.searchParams.get("cursor")).toBe("cur");
  expect(url.searchParams.get("latest")).toBe("1700000900.000100");
  expect(url.searchParams.get("oldest")).toBe("1700000000.000100");
});

test("replies omits the optional parameters that are not given", async () => {
  const { calls, fetch } = fakeFetch(() =>
    jsonResponse({ messages: [], ok: true })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  await client.replies({ channel: "C1", limit: 5, ts: "1700000000.000100" });

  const url = new URL(firstCall(calls).url);
  expect(url.searchParams.get("ts")).toBe("1700000000.000100");
  expect(url.searchParams.has("cursor")).toBe(false);
  expect(url.searchParams.has("latest")).toBe(false);
  expect(url.searchParams.has("oldest")).toBe(false);
});

test("replies maps the thread and returns next_cursor when Slack gives one", async () => {
  const { fetch } = fakeFetch(() =>
    jsonResponse({
      messages: [
        { text: "parent", ts: "1700000000.000100", user: "U1" },
        {
          text: "reply",
          thread_ts: "1700000000.000100",
          ts: "1700000050.000100",
          user: "U2",
        },
        { text: "no ts" },
      ],
      ok: true,
      response_metadata: { next_cursor: "more" },
    })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.replies({
    channel: "C1",
    limit: 10,
    ts: "1700000000.000100",
  });

  expect(result).toEqual({
    kind: "ok",
    messages: [
      {
        botId: null,
        text: "parent",
        threadTs: null,
        ts: "1700000000.000100",
        user: "U1",
      },
      {
        botId: null,
        text: "reply",
        threadTs: "1700000000.000100",
        ts: "1700000050.000100",
        user: "U2",
      },
    ],
    nextCursor: "more",
  });
});

test("replies classifies not_in_channel as config", async () => {
  const { fetch } = fakeFetch(() =>
    jsonResponse({ error: "not_in_channel", ok: false })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.replies({
    channel: "C1",
    limit: 10,
    ts: "1700000000.000100",
  });

  expect(result).toEqual({ error: "not_in_channel", kind: "config" });
});

test("replies maps a ratelimited body to rate_limited", async () => {
  const { fetch } = fakeFetch(() =>
    jsonResponse({ error: "ratelimited", ok: false }, 200, {
      "Retry-After": "3",
    })
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.replies({
    channel: "C1",
    limit: 10,
    ts: "1700000000.000100",
  });

  expect(result).toEqual({ kind: "rate_limited", retryAfterSeconds: 3 });
});

test("replies rejects a body without messages", async () => {
  const { fetch } = fakeFetch(() => jsonResponse({ ok: true }));
  const client = createSlackClient({ fetch, token: TOKEN });

  const result = await client.replies({
    channel: "C1",
    limit: 10,
    ts: "1700000000.000100",
  });

  expect(result).toEqual({ error: "no_error", kind: "rejected" });
});
