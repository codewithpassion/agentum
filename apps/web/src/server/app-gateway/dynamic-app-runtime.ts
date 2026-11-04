/**
 * Runs an app's server part in a Dynamic Worker. One Worker per version,
 * cached by the loader under `app:<versionId>`, with a loader config that
 * holds nothing about the viewer: the callback runs once per id, so anything
 * in it would stick to whoever loaded the Worker first
 * (`docs/v3/phase2-spike.md` Q2). Each request instead makes a new `AgentumHost` stub
 * and passes it to the generated harness as an RPC argument.
 */

import { APP_HARNESS, appModules } from "./modules.ts";
import type { AppRuntime } from "./ports.ts";
import type { AppHostProps, AppOutboundProps } from "./types.ts";

/** The same date as the Worker and the skill-script loader. */
const COMPATIBILITY_DATE = "2026-08-19";
/** Outbound requests per call, as `MAX_SUBREQUESTS` in `dynamic-worker-sandbox.ts`. */
const MAX_SUBREQUESTS = 50;
const CPU_MS = 10_000;

interface Harness {
  handle: (request: Request, hm: unknown) => Promise<Response>;
}

export interface DynamicAppRuntimeDeps {
  /** `ctx.exports.AppHost({ props })`: a stub bound to one request's viewer. */
  hostStub: (props: AppHostProps) => unknown;
  loader: WorkerLoader;
  /** `ctx.exports.AppOutbound({ props })`: the `globalOutbound` for a version that declares hosts. */
  outboundStub: (props: AppOutboundProps) => Fetcher;
}

export const dynamicAppRuntime = (deps: DynamicAppRuntimeDeps): AppRuntime => ({
  handle: ({ bundle, host, request }) => {
    const worker = deps.loader.get(`app:${host.versionId}`, async () => {
      const found = await bundle(host.artifactId, host.versionId);
      if (found === null) {
        throw new Error("The version has no server part.");
      }
      return {
        compatibilityDate: COMPATIBILITY_DATE,
        env: {},
        globalOutbound: found.declaresHosts
          ? deps.outboundStub({
              artifactId: host.artifactId,
              versionId: host.versionId,
              workspaceId: host.workspaceId,
            })
          : null,
        limits: { cpuMs: CPU_MS, subRequests: MAX_SUBREQUESTS },
        mainModule: APP_HARNESS,
        modules: appModules(found.files),
      };
    });
    const harness = worker.getEntrypoint("Harness") as unknown as Harness;
    return harness.handle(request, deps.hostStub(host));
  },
});
