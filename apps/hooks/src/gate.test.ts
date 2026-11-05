import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { build } from "bun";

// Resolved at run time, as before the move, so the fixtures stay loosely typed.
const { Miniflare, convertV4MiniflareOptions } = await import(
  import.meta.resolve("miniflare")
);

test("gate: real front, D1, R2, loader and MAIN binding answer cold and warm under 1 s", async () => {
  const built = await build({
    entrypoints: [fileURLToPath(new URL("./gate-fixture.ts", import.meta.url))],
    external: ["cloudflare:workers"],
    format: "esm",
    target: "node",
  });
  expect(built.success).toBe(true);
  const start = performance.now();
  const flare = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          compatibilityDate: "2026-08-19",
          d1Databases: ["DB"],
          modules: true,
          name: "front",
          r2Buckets: ["FILES"],
          script: await built.outputs[0]?.text(),
          serviceBindings: { MAIN: "main" },
          workerLoaders: { LOADER: {} },
        },
        {
          compatibilityDate: "2026-08-19",
          modules: true,
          name: "main",
          script:
            'export default { fetch() { throw new Error("MAIN called"); } }',
        },
      ],
    })
  );
  try {
    const db = await flare.getD1Database("DB", "front");
    await db.exec(
      "CREATE TABLE endpoints (id TEXT, version TEXT); INSERT INTO endpoints VALUES ('gate', 'v-gate')"
    );
    const bucket = await flare.getR2Bucket("FILES", "front");
    await bucket.put(
      "server.js",
      'export default { fetch() { return new Response("accepted"); } }'
    );
    console.log("hooks gate setup ms", Math.round(performance.now() - start));
    for (const phase of ["cold", "warm"]) {
      const sent = performance.now();
      // biome-ignore lint/performance/noAwaitInLoops: cold then warm measurement
      const response = await fetch(new URL("/hooks/gate", await flare.ready));
      expect(await response.text()).toBe("accepted");
      const elapsed = performance.now() - sent;
      console.log(
        "hooks gate",
        phase,
        "external ms",
        Math.round(elapsed),
        "stages",
        response.headers.get("x-timing")
      );
      expect(elapsed).toBeLessThan(1000);
    }
  } finally {
    await flare.dispose();
  }
}, 60_000);
