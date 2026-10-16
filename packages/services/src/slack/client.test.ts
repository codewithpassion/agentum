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
