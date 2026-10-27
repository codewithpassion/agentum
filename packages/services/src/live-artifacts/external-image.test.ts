/** biome-ignore-all lint/suspicious/useAwait: Captured fetch adapters match the asynchronous production port. */
/** biome-ignore-all lint/performance/noAwaitInLoops: Ordered hostile-input cases verify fetch counts. */
import { expect, test } from "bun:test";
import { fetchExternalImage, type ImageFetch } from "./external-image.ts";

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const url = "https://images.unsplash.com/photo";
test("fixed public origins refuse internal, credentials, alternate protocols and redirects before fetching them", async () => {
  let calls = 0;
  const fetcher: ImageFetch = async () => {
    calls += 1;
    return Response.redirect("http://169.254.169.254/latest/meta-data", 302);
  };
  for (const value of [
    "http://images.unsplash.com/x",
    "https://localhost/x",
    "https://127.0.0.1/x",
    "https://[::1]/x",
    "https://images.unsplash.com.evil.test/x",
    "https://user:pass@images.unsplash.com/x",
    "https://images.unsplash.com:8443/x",
    "file:///etc/passwd",
  ]) {
    await expect(fetchExternalImage(value, fetcher)).rejects.toThrow();
  }
  expect(calls).toBe(0);
  await expect(fetchExternalImage(url, fetcher)).rejects.toThrow();
  expect(calls).toBe(1);
});
test("redirect count, byte length, declared MIME and actual signatures are bounded", async () => {
  let calls = 0;
  await expect(
    fetchExternalImage(url, async () => {
      calls += 1;
      return Response.redirect("https://images.unsplash.com/again", 302);
    })
  ).rejects.toThrow();
  expect(calls).toBe(4);
  for (const response of [
    new Response(png, { headers: { "Content-Type": "text/html" } }),
    new Response("<svg>active</svg>", {
      headers: { "Content-Type": "image/png" },
    }),
    new Response(png, { headers: { "Content-Type": "image/jpeg" } }),
    new Response(png, {
      headers: { "Content-Length": "8388609", "Content-Type": "image/png" },
    }),
    new Response(new Uint8Array(8 * 1024 * 1024 + 1), {
      headers: { "Content-Type": "image/png" },
    }),
  ]) {
    await expect(
      fetchExternalImage(url, async () => response)
    ).rejects.toThrow();
  }
  const body = await fetchExternalImage(url, async (_input, init) => {
    expect(init?.credentials).toBe("omit");
    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return new Response(png, { headers: { "Content-Type": "image/png" } });
  });
  expect(body.size).toBe(12);
});

test("total deadline cancels a stalled body instead of waiting for unbounded input", async () => {
  const { spyOn } = await import("bun:test");
  const controller = new AbortController();
  const timeout = spyOn(AbortSignal, "timeout").mockImplementation(
    (milliseconds) => {
      expect(milliseconds).toBe(10_000);
      return controller.signal;
    }
  );
  let cancelled = false;
  try {
    const pending = fetchExternalImage(url, async () => {
      setTimeout(() => controller.abort(new Error("Deadline exceeded")), 5);
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "Content-Type": "image/png" } }
      );
    });
    await expect(pending).rejects.toThrow("Deadline exceeded");
    expect(cancelled).toBe(true);
  } finally {
    timeout.mockRestore();
  }
});
