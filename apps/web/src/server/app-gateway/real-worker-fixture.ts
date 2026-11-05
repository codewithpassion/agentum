/**
 * The Worker the real-loader test runs in Miniflare (`real-worker.test.ts`
 * bundles this file). It is the gateway wired to fake ports, with control
 * routes under `/__` so the test can seed bundles and change the share and
 * the approved hosts between requests. Not part of the app.
 */

import { dynamicAppRuntime } from "@repo/app-gateway/dynamic-app-runtime";
import { fakePorts } from "@repo/app-gateway/fakes";
import { handleAppRequest } from "@repo/app-gateway/gateway-core";
import type { AppBundle, ShareState } from "@repo/app-gateway/ports";
import type { AppHostProps, AppReplyMessage } from "@repo/app-gateway/types";
import type { ViewTokenClaims } from "@repo/protocol/artifacts";
import { Hono } from "hono";
import type { AppEnv } from "../routes/groups.ts";
import { mountEndpointRoutes } from "./endpoints.ts";
import { defineAppEntrypoints } from "./entrypoints.ts";

interface Seed {
  declaresHosts: boolean;
  files: { path: string; text: string }[];
  hosts?: string[];
  versionId: string;
  withSecret?: boolean;
}

const ports = fakePorts();
const bundles = new Map<string, AppBundle>();
let withSecret = false;
const { read } = ports.grants;
ports.grants.read = async (props) => ({
  ...(await read(props)),
  secretRules: () =>
    Promise.resolve(
      withSecret
        ? [
            {
              header: "Authorization",
              headerValue: "Bot fixture-secret",
              name: "BOT_TOKEN",
              value: "fixture-secret",
            },
          ]
        : []
    ),
});
const errors: { entry: string; message: string }[] = [];
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
    withSecret = seed.withSecret ?? false;
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
    if (pathname === "/__errors") {
      return Response.json(errors);
    }
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
      defer: (work: Promise<void>) => ctx.waitUntil(work),
      ports,
      recordError: (_target: unknown, entry: string, error: unknown) => {
        errors.push({ entry, message: String(error) });
        return Promise.resolve();
      },
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
      const app = new Hono<AppEnv>();
      mountEndpointRoutes(app, {
        limiter: () => ({ limit: () => Promise.resolve({ success: true }) }),
        wiring: () => ({
          ...deps,
          declaresHosts: () => Promise.resolve(false),
          endpoints: {
            recordCall: () => Promise.resolve(),
            resolve: () =>
              Promise.resolve({
                artifactId: "11111111-1111-4111-8111-111111111111",
                endpointId: "signature",
                name: "discord",
                versionId: request.headers.get("x-test-version") ?? "",
                workspaceId: "ws-1",
              }),
          },
        }),
      });
      return await app.request(request, undefined, undefined, ctx);
    }
    return await handleAppRequest(request, claims, deps);
  },
};
