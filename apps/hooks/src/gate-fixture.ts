import { WorkerEntrypoint } from "cloudflare:workers";
import { dynamicAppRuntime } from "@repo/app-gateway/dynamic-app-runtime";

export class GateHost extends WorkerEntrypoint {
  whoami() {
    throw new Error("The gate app must not call MAIN");
  }
}

export default {
  async fetch(
    request: Request,
    env: {
      DB: D1Database;
      FILES: R2Bucket;
      LOADER: WorkerLoader;
      MAIN: Fetcher;
    },
    ctx: ExecutionContext
  ) {
    const started = performance.now();
    const row = await env.DB.prepare(
      "SELECT version FROM endpoints WHERE id = ?"
    )
      .bind("gate")
      .first<{ version: string }>();
    const resolved = performance.now();
    if (!row) {
      return new Response("missing", { status: 404 });
    }
    let bundleMs = 0;
    const runtime = dynamicAppRuntime({
      hostStub: () =>
        (
          ctx.exports as unknown as {
            GateHost: (options: { props: object }) => unknown;
          }
        ).GateHost({ props: {} }),
      loader: env.LOADER,
      outboundStub: () => env.MAIN,
    });
    const response = await runtime.handle({
      background: {
        defer: (work) => ctx.waitUntil(work),
        onError: () => Promise.resolve(),
      },
      bundle: async () => {
        const start = performance.now();
        const object = await env.FILES.get("server.js");
        if (!object) {
          return null;
        }
        const bytes = new Uint8Array(await object.arrayBuffer());
        bundleMs = performance.now() - start;
        return {
          declaresHosts: false,
          files: [{ bytes, path: "server/index.js" }],
        };
      },
      host: {
        artifactId: "a",
        meta: { ipPrefix: null, place: null, userAgent: null, visitorHash: "" },
        versionId: row.version,
        viewer: { endpointId: "gate", kind: "endpoint" },
        workspaceId: "w",
      },
      request,
    });
    return new Response(response.body, {
      headers: {
        "x-timing": JSON.stringify({
          app: performance.now() - resolved,
          bundle: bundleMs,
          resolve: resolved - started,
          total: performance.now() - started,
        }),
      },
    });
  },
};
