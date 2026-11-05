/**
 * Runs an app's server part in a Dynamic Worker. One Worker per version,
 * cached by the loader under `app:<versionId>`, with a loader config that
 * holds nothing about the viewer: the callback runs once per id, so anything
 * in it would stick to whoever loaded the Worker first
 * (`docs/v3/phase2-spike.md` Q2). Each request instead makes a new `AgentumHost` stub
 * and passes it to the generated harness as an RPC argument.
 */

import { APP_HARNESS, appModules } from "./modules.ts";
import type { AppRuntimeInput } from "./ports.ts";
import type {
  AppHostProps,
  AppOutboundProps,
  AppReplyMessage,
} from "./types.ts";

/** The same date as the Worker and the skill-script loader. */
const COMPATIBILITY_DATE = "2026-08-19";
/** Outbound requests per call, as `MAX_SUBREQUESTS` in `dynamic-worker-sandbox.ts`. */
const MAX_SUBREQUESTS = 50;
const CPU_MS = 10_000;

interface Harness {
  handle: (
    request: Request,
    host: unknown,
    respond: (response: Response) => void
  ) => Promise<void>;
  reply: (message: AppReplyMessage, host: unknown) => Promise<void>;
}

export interface DynamicAppRuntimeDeps {
  /** `ctx.exports.AppHost({ props })`: a stub bound to one request's viewer. */
  hostStub: (props: AppHostProps) => unknown;
  loader: WorkerLoader;
  /** `ctx.exports.AppOutbound({ props })`: the `globalOutbound` for a version that declares hosts. */
  outboundStub: (props: AppOutboundProps) => Fetcher;
}

export const dynamicAppRuntime = (deps: DynamicAppRuntimeDeps) => {
  const harnessOf = (
    bundle: AppRuntimeInput["bundle"],
    host: AppHostProps
  ): Harness => {
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
    return worker.getEntrypoint("Harness") as unknown as Harness;
  };
  return {
    handle: ({ background, bundle, host, request }: AppRuntimeInput) =>
      new Promise<Response>((resolve, reject) => {
        let responded = false;
        const work = harnessOf(bundle, host)
          .handle(request, deps.hostStub(host), (response) => {
            responded = true;
            resolve(response);
          })
          .catch(async (error: unknown) => {
            if (responded) {
              await background?.onError(error);
            } else {
              reject(error);
            }
          });
        // Keep the RPC (and its request-bound host/outbound stubs) alive after
        // the callback has handed the response to the gateway.
        background?.defer(work);
      }),
    reply: async ({
      bundle,
      host,
      message,
    }: {
      bundle: AppRuntimeInput["bundle"];
      host: AppHostProps;
      message: AppReplyMessage;
    }) => {
      const found = await bundle(host.artifactId, host.versionId);
      if (!found) {
        return;
      }
      await harnessOf(async () => found, host).reply(
        message,
        deps.hostStub(host)
      );
    },
  };
};
