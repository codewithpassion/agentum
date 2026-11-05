/**
 * Fills the app gateway's ports from the composed services. One builder serves
 * the route in `server.ts` and the `AppHost` / `AppOutbound` entrypoints, so
 * both read the same grants, shares and storage. Kept free of
 * `cloudflare:workers` so bun can test it.
 */
import { artifactManifestSchema } from "@repo/protocol/artifacts";
import { isArtifactCallError } from "@repo/services/artifacts/calls";
import { isForbiddenError } from "@repo/services/authz";
import { isServiceError } from "@repo/services/errors";
import { canWrite } from "../app-store/rules.ts";
import {
  blobKey,
  type ContentBucket,
  manifestKey,
} from "../artifact-content/routes.ts";
import type { Services } from "../compose.ts";
import { appError } from "./app-host-core.ts";
import type { AppBundle, AppCallPort, AppGatewayPorts } from "./ports.ts";
import type { AppStorePort } from "./types.ts";

const SERVER_DIR = "server/";
const decoder = new TextDecoder();

type PortServices = Pick<
  Services,
  "artifactApp" | "artifactCalls" | "artifactShares"
>;

const REFUSAL_CODES = ["forbidden", "not_granted", "rate_limited", "too_large"];

/** An error `appError` made: its text starts with a code the app may see. */
const isAppRefusal = (error: unknown): boolean =>
  error instanceof Error &&
  REFUSAL_CODES.some((code) => error.message.startsWith(`${code}: `));

/** A failure of the platform's own side (database, Clerk): the app learns that it failed, never why. */
const platformFailure = (error: unknown): Error => {
  console.error(
    "App call failed",
    error instanceof Error ? error.name : "unknown error"
  );
  return new Error("failed: the tool call failed");
};

/** A tool call that went wrong, as the error the app's code sees. */
const callError = (error: unknown): Error => {
  if (isArtifactCallError(error)) {
    return new Error(`${error.code}: ${error.message}`);
  }
  if (isServiceError(error) || isForbiddenError(error)) {
    // A hidden artifact or a refused principal.
    return appError("forbidden", "the call was refused");
  }
  return platformFailure(error);
};

const argumentsOf = (args: unknown): Record<string, unknown> => {
  if (args === undefined || args === null) {
    return {};
  }
  if (typeof args !== "object" || Array.isArray(args)) {
    throw new TypeError("tool arguments must be an object");
  }
  return args as Record<string, unknown>;
};

const memberCalls =
  (services: PortServices): AppCallPort["asMember"] =>
  async (call) => {
    const args = argumentsOf(call.args);
    try {
      const principal = await services.artifactApp.memberPrincipal(
        call.userId,
        call.workspaceId
      );
      if (!principal) {
        throw appError("forbidden", "the person is no longer a member");
      }
      const { result } = await services.artifactCalls.callTool(principal, {
        arguments: args,
        artifactId: call.artifactId,
        tool: call.tool,
        versionId: call.versionId,
      });
      return result;
    } catch (error) {
      throw isAppRefusal(error) ? error : callError(error);
    }
  };

const linkCalls =
  (services: PortServices): AppCallPort["asLink"] =>
  async (call) => {
    const args = argumentsOf(call.args);
    let result: Awaited<
      ReturnType<PortServices["artifactShares"]["callShare"]>
    >;
    try {
      result = await services.artifactShares.callShare(
        call.shareId,
        call.artifactId,
        { arguments: args, tool: call.tool },
        {
          ipPrefix: call.meta.ipPrefix,
          place: call.meta.place,
          userAgent: call.meta.userAgent,
          visitorHash: call.meta.visitorHash || null,
        }
      );
    } catch (error) {
      throw platformFailure(error);
    }
    if (result.ok) {
      return result.result;
    }
    switch (result.reason) {
      case "not_found":
        throw appError("forbidden", "the link is no longer available");
      case "forbidden":
        throw appError("not_granted", "this link cannot run that tool");
      case "rate_limited":
        throw appError("rate_limited", "too many calls");
      default:
        throw new Error("failed: the tool call failed");
    }
  };

const bundleOf =
  (services: PortServices, bucket: ContentBucket) =>
  async (artifactId: string, versionId: string): Promise<AppBundle | null> => {
    const workspaceId = await services.artifactApp.versionWorkspaceId(
      artifactId,
      versionId
    );
    if (!workspaceId) {
      return null;
    }
    const manifestObject = await bucket.get(
      manifestKey(workspaceId, versionId)
    );
    if (!manifestObject) {
      return null;
    }
    const manifest = artifactManifestSchema.parse(
      JSON.parse(decoder.decode(await manifestObject.arrayBuffer()))
    );
    const files = await Promise.all(
      Object.entries(manifest.files)
        .filter(([path]) => path.startsWith(SERVER_DIR))
        .map(async ([path, file]) => {
          const blob = await bucket.get(blobKey(workspaceId, file.sha256));
          if (!blob) {
            throw new Error(`The blob of ${path} is missing.`);
          }
          return { bytes: new Uint8Array(await blob.arrayBuffer()), path };
        })
    );
    return {
      declaresHosts: await services.artifactApp.declaresHosts(versionId),
      files,
    };
  };

export const createAppGatewayPorts = ({
  bucket,
  services,
  store,
}: {
  bucket: ContentBucket;
  services: PortServices;
  store: AppStorePort;
}): AppGatewayPorts => ({
  calls: { asLink: linkCalls(services), asMember: memberCalls(services) },
  canWrite,
  grants: {
    announce: (props, host, names) => {
      // Names and host only; the platform has no run to attach an event to.
      console.info(
        `app secrets added: artifact=${props.artifactId} version=${props.versionId} host=${host} names=${names.join(",")}`
      );
      return Promise.resolve();
    },
    read: (props) =>
      services.artifactApp.outboundPolicy(props.workspaceId, props.versionId),
  },
  shares: {
    state: (shareId, artifactId) =>
      services.artifactShares.shareState(shareId, artifactId),
  },
  source: { bundle: bundleOf(services, bucket) },
  startRun: (props, input) => services.artifactApp.startRun(props, input),
  store,
});
