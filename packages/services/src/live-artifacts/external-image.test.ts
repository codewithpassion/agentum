/** biome-ignore-all lint/suspicious/useAwait: Captured fetch adapters match the asynchronous production port. */
/** biome-ignore-all lint/performance/noAwaitInLoops: Ordered hostile-input cases verify fetch counts. */
import { expect, test } from "bun:test";
import { fetchExternalImage, type ImageFetch } from "./external-image.ts";

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const url = "https://images.unsplash.com/photo";
test("public URL validation refuses internal addresses, credentials, alternate protocols and redirects before fetching them", async () => {
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
    "https://127.1/x",
    "https://0x7f000001/x",
    "https://[::ffff:127.0.0.1]/x",
    "https://10.0.0.1/x",
    "https://100.100.100.200/x",
    "https://images.internal/x",
    "https://single-label/x",
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
    expect(init.deadline).toBeGreaterThan(Date.now());
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

test("other public HTTPS hosts and public-to-public redirects use the bounded image path", async () => {
  const visited: string[] = [];
  const body = await fetchExternalImage(
    "https://photos.example.com/image",
    async (input, init) => {
      visited.push(input);
      expect(init.method).toBe("GET");
      expect(init.credentials).toBe("omit");
      if (visited.length === 1) {
        return Response.redirect("https://cdn.another.example/image", 302);
      }
      return new Response(png, { headers: { "Content-Type": "image/png" } });
    }
  );
  expect(body.size).toBe(12);
  expect(visited).toEqual([
    "https://photos.example.com/image",
    "https://cdn.another.example/image",
  ]);
});

test("each broader-host redirect rechecks HTTPS, address, port and userinfo rules", async () => {
  for (const location of [
    "https://127.0.0.1/metadata",
    "https://[::ffff:127.0.0.1]/metadata",
    "https://metadata.internal/image",
    "https://public.example.com:8443/image",
    "https://public.example.com@127.0.0.1/image",
  ]) {
    let calls = 0;
    await expect(
      fetchExternalImage(
        "https://public-images.example.com/image",
        async () => {
          calls += 1;
          return Response.redirect(location, 302);
        }
      )
    ).rejects.toThrow();
    expect(calls).toBe(1);
  }
});
