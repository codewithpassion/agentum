/**
 * Everything the app gateway, `AppHost` and `AppOutbound` need from other
 * tasks, as ports. B.8 builds one `AppGatewayPorts` from `compose` and hands
 * the factory to `defineAppEntrypoints`. Tests pass fakes.
 */
import type { ProxyMatch } from "@repo/services/secrets";
import type { SandboxFile } from "../skill-scripts/sandbox-port.ts";
import type {
  AppHostProps,
  AppRequestMeta,
  AppStorePort,
  AppViewer,
  StorageArea,
} from "./types.ts";

/** What the gateway needs to run a version: its `server/` files, and whether it declared any host. */
export interface AppBundle {
  /** True when the version has any `host` grant row, approved or not. That set is fixed at publish, so the gateway can decide `globalOutbound` once per cached Worker. */
  declaresHosts: boolean;
  /** The files under `server/`, by path from the artifact root. */
  files: SandboxFile[];
}

export interface AppSourcePort {
  /** Read on a cold start only: the loader callback runs once per version. */
  bundle: (artifactId: string, versionId: string) => Promise<AppBundle | null>;
  /** The workspace that owns the artifact, or null when the version does not belong to it. Read on every request. */
  workspaceOf: (
    artifactId: string,
    versionId: string
  ) => Promise<string | null>;
}

export type ShareState =
  | { dataMode: "snapshot" | "live"; ok: true }
  | { ok: false; reason: "revoked" | "expired" | "disabled" | "unknown" };

export interface ShareCheckPort {
  /** Read fresh each time: a revoked or expired link is refused on the next call (R2.12). */
  state: (shareId: string, artifactId: string) => Promise<ShareState>;
}

export interface AppToolCall {
  args: unknown;
  artifactId: string;
  /** `<serverKey>/<tool>` */
  tool: string;
  versionId: string;
  workspaceId: string;
}

export interface AppCallPort {
  /** B.6's `ShareGrant` entry. Refuses with `forbidden`, `not_granted` or `rate_limited`, and writes the access-log row. */
  asLink: (
    call: AppToolCall & { meta: AppRequestMeta; shareId: string }
  ) => Promise<unknown>;
  /** B.5's `callTool`. The adapter builds a fresh `Principal` for `userId` and re-checks membership. */
  asMember: (call: AppToolCall & { userId: string }) => Promise<unknown>;
}

export interface AppGrantsPort {
  /** Called after credentials were added to a request. Names and host only. May reject: the call goes on. */
  announce: (
    props: { artifactId: string; versionId: string; workspaceId: string },
    host: string,
    names: string[]
  ) => Promise<void>;
  /** The hosts a person approved for the version, read on each outbound request. */
  approvedHosts: (versionId: string) => Promise<readonly string[]>;
  /** Secret placeholders that apply to a request to `host`, from the version's approved `secret` grants. */
  secretRules: (
    props: { artifactId: string; versionId: string; workspaceId: string },
    host: string
  ) => Promise<ProxyMatch[]>;
}

export interface AppGatewayPorts {
  calls: AppCallPort;
  /** B.3's `canWrite`. Called before every `set` and `delete`. */
  canWrite: (viewer: AppViewer, area: StorageArea) => boolean;
  grants: AppGrantsPort;
  shares: ShareCheckPort;
  source: AppSourcePort;
  store: AppStorePort;
}

export interface AppRuntimeInput {
  /** Read through `bundle` on a cold start only. */
  bundle: AppSourcePort["bundle"];
  host: AppHostProps;
  request: Request;
}

/**
 * Where an app's server part runs. One call is one request. The Dynamic
 * Worker implementation is `dynamic-app-runtime.ts`; Workers for Platforms
 * could replace it. A failure of the app is a rejection, which the gateway
 * turns into a 502 with a fixed body.
 */
export interface AppRuntime {
  handle: (input: AppRuntimeInput) => Promise<Response>;
}
