import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, spawn } from "bun";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { IMAGE_EGRESS_CODE } from "./public-image-fetch";

const bundle = async () => {
  const result = await build({
    entrypoints: [`${import.meta.dir}/fixtures/public-image-worker.ts`],
    target: "browser",
  });
  if (!(result.success && result.outputs[0])) {
    throw new Error("Image transport fixture build failed");
  }
  return result.outputs[0].text();
};
test("image egress isolates strictly-public routing without inheriting any bindings or privileged outbound", () => {
  expect(IMAGE_EGRESS_CODE.compatibilityFlags).toEqual([
    "global_fetch_strictly_public",
  ]);
  expect(IMAGE_EGRESS_CODE.env).toEqual({});
  expect(IMAGE_EGRESS_CODE.globalOutbound).toBeUndefined();
  expect(IMAGE_EGRESS_CODE.limits?.subRequests).toBe(1);
});
test("real image Worker strips caller credentials and preserves a manual redirect for revalidation", async () => {
  let calls = 0;
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      compatibilityDate: "2026-08-19",
      modules: true,
      outboundService: (request: Request) => {
        calls += 1;
        expect(request.url).toBe("https://public-images.example.com/image");
        expect(request.method).toBe("GET");
        for (const header of [
          "cookie",
          "authorization",
          "referer",
          "proxy-authorization",
          "x-hm-image-deadline",
        ]) {
          expect(request.headers.has(header)).toBe(false);
        }
        return Response.redirect(
          "https://other-public.example.com/redirected",
          302
        );
      },
      script: await bundle(),
      workerLoaders: { LOADER: {} },
    })
  );
  try {
    const response = await fetch(
      new URL(
        "?url=https://public-images.example.com/image",
        await runtime.ready
      )
    );
    expect(await response.json()).toMatchObject({ status: 302 });
    expect(calls).toBe(1);
  } finally {
    await runtime.dispose();
  }
}, 30_000);
test("unmocked workerd public network rejects private peers and DNS-resolved loopback at transport", async () => {
  const directory = await mkdtemp(join(tmpdir(), "public-image-transport-"));
  const fromWrangler = createRequire(
    createRequire(import.meta.url).resolve("wrangler/package.json")
  );
  const workerd = fromWrangler.resolve("workerd/bin/workerd");
  try {
    const source = `export default { async test(controller, env) {
      const worker = env.LOADER.get("image-transport-test", () => (${JSON.stringify(IMAGE_EGRESS_CODE)})).getEntrypoint();
      for (const url of ["https://localhost/", "https://127.0.0.1/", "https://[::1]/", "https://10.0.0.1/", "https://169.254.169.254/"]) {
        let refusal = "";
        try { await worker.fetch(url, {headers: {"x-hm-image-deadline": String(Date.now() + 2000)}}); } catch (cause) { refusal = String(cause); }
        if (!refusal) { throw new Error("Missing transport refusal for " + url + ": " + refusal); }
      }
    }};`;
    await writeFile(join(directory, "worker.js"), source);
    await writeFile(
      join(directory, "config.capnp"),
      `using Workerd = import "/workerd/workerd.capnp";
      const config :Workerd.Config = (services = [
        (name = "main", worker = (compatibilityDate = "2026-08-19", modules = [(name = "worker.js", esModule = embed "worker.js")], bindings = [(name = "LOADER", workerLoader = ())])),
        (name = "internet", network = (allow = ["public"], tlsOptions = (trustBrowserCas = true)))
      ]);`
    );
    const child = spawn(
      [workerd, "test", "--experimental", join(directory, "config.capnp")],
      {
        stderr: "pipe",
        stdout: "pipe",
      }
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) {
      throw new Error(`${stdout}\n${stderr}`);
    }
    expect(code).toBe(0);
    expect(
      (stderr.match(/connect\(\) blocked by restrictPeers/g) ?? []).length
    ).toBeGreaterThanOrEqual(5);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 30_000);

test("the deadline aborts a stalled response through the real image Worker boundary", async () => {
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      compatibilityDate: "2026-08-19",
      modules: true,
      outboundService: () =>
        new Response(new ReadableStream(), {
          headers: { "Content-Type": "image/png" },
        }),
      script: await bundle(),
      workerLoaders: { LOADER: {} },
    })
  );
  try {
    const started = Date.now();
    const response = await fetch(
      new URL(
        "?url=https://public-images.example.com/stalled",
        await runtime.ready
      )
    );
    expect(await response.json()).toMatchObject({ error: expect.any(String) });
    // The parent fixture signal has a four-second deadline; the image Worker
    // must enforce the earlier two-second transport deadline itself.
    expect(Date.now() - started).toBeLessThan(3500);
  } finally {
    await runtime.dispose();
  }
}, 10_000);
