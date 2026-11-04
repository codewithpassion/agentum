/**
 * The Worker the real-loader test runs in Miniflare (`real-worker.test.ts`
 * bundles this file). It is the gateway wired to fake ports, with control
 * routes under `/__` so the test can seed bundles and change the share and
 * the approved hosts between requests. Not part of the app.
 */
import type { ViewTokenClaims } from "@repo/protocol/artifacts";
import { dynamicAppRuntime } from "./dynamic-app-runtime.ts";
import { defineAppEntrypoints } from "./entrypoints.ts";
import { fakePorts } from "./fakes.ts";
import { handleAppRequest, handleEndpointRequest } from "./gateway-core.ts";
import type { AppBundle, ShareState } from "./ports.ts";
import type { AppHostProps, AppReplyMessage } from "./types.ts";

interface Seed {
  declaresHosts: boolean;
  files: { path: string; text: string }[];
  hosts?: string[];
  versionId: string;
}

const ports = fakePorts();
const bundles = new Map<string, AppBundle>();
ports.source.bundle = (_artifactId, versionId) =>
  Promise.resolve(bundles.get(versionId) ?? null);

export const { AppHost, AppOutbound } = defineAppEntrypoints(() => ports);

type Stub = (options: { props: unknown }) => unknown;

const control = async (request: Request, path: string): Promise<Response> => {
  const body: unknown = await request.json();
  if (path === "/__seed") {
    const seed = body as Seed;
    const encoder = new TextEncoder();
    bundles.set(seed.versionId, {
      declaresHosts: seed.declaresHosts,
      files: seed.files.map((file) => ({
        bytes: encoder.encode(file.text),
        path: file.path,
      })),
    });
    ports.hosts.list = seed.hosts ?? [];
  } else if (path === "/__share") {
    ports.share.state = body as ShareState;
  } else if (path === "/__hosts") {
    ports.hosts.list = body as string[];
  }
  return new Response("ok");
};

const wrap = (response: Response): Response => {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", "sandbox allow-scripts allow-forms");
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(response.body, { headers, status: response.status });
};

export default {
  async fetch(
    request: Request,
    env: { LOADER: WorkerLoader },
    ctx: ExecutionContext
  ): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/__reply") {
      const { versionId, message } = (await request.json()) as {
        versionId: string;
        message: AppReplyMessage;
      };
      const host: AppHostProps = {
        artifactId: "11111111-1111-4111-8111-111111111111",
        meta: { ipPrefix: null, place: null, userAgent: null, visitorHash: "" },
        versionId,
        viewer: { kind: "reply", runId: message.runId },
        workspaceId: "ws-1",
      };
      const runtime = dynamicAppRuntime({
        hostStub: (props) => ctx.exports.AppHost({ props }),
        loader: env.LOADER,
        outboundStub: (props) => ctx.exports.AppOutbound({ props }) as Fetcher,
      });
      try {
        await runtime.reply({ bundle: ports.source.bundle, host, message });
        const value = await ports.store.get(
          { area: "shared", artifactId: host.artifactId, viewerKey: "" },
          "reply-result"
        );
        return Response.json(value ? JSON.parse(value) : null);
      } catch {
        return new Response("reply failed", { status: 500 });
      }
    }
    if (pathname.startsWith("/__")) {
      return await control(request, pathname);
    }
    const claims = JSON.parse(
      request.headers.get("x-test-claims") ?? "{}"
    ) as ViewTokenClaims;
    const { exports } = ctx as unknown as {
      exports: { AppHost: Stub; AppOutbound: Stub };
    };
    const deps = {
      applyContentHeaders: wrap,
      ports,
      requestMeta: () =>
        Promise.resolve({
          ipPrefix: null,
          place: null,
          userAgent: null,
          visitorHash: "vh",
        }),
      runtime: dynamicAppRuntime({
        hostStub: (props) => exports.AppHost({ props }),
        loader: env.LOADER,
        outboundStub: (props) =>
          exports.AppOutbound({ props }) as unknown as Fetcher,
      }),
      wallMs: 20_000,
    };
    if (pathname.startsWith("/hooks/")) {
      return await handleEndpointRequest(
        request,
        {
          artifactId: "11111111-1111-4111-8111-111111111111",
          endpointId: "signature",
          versionId: request.headers.get("x-test-version") ?? "",
          workspaceId: "ws-1",
        },
        deps
      );
    }
    return await handleAppRequest(request, claims, deps);
  },
};
