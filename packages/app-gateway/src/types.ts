/**
 * The contract between the app gateway, `AppHost` (the `env.AGENTUM` an app's
 * server part sees) and the tasks that fill its ports. The shapes are the
 * ones `docs/v3/phase2-spike.md` defines.
 */

/** One file of an app's server part, by path from the artifact root. */
export interface AppFile {
  bytes: Uint8Array;
  path: string;
}

/** Page viewers from the verified content token, never from app code. Endpoint and reply viewers are host-only below. */
export type AppViewer =
  | { kind: "member"; userId: string }
  | { kind: "link"; shareId: string; dataMode: "snapshot" | "live" };

/**
 * Who `AppHost` serves. A `test` viewer is a Browser Run check of a version
 * (`artifact_test`): it reads the shared area and can do nothing else.
 */
export type AppHostViewer =
  | AppViewer
  | { kind: "test" }
  | { kind: "endpoint"; endpointId: string }
  | { kind: "reply"; runId: string };

export interface AppStartRunInput {
  agent: string;
  /** Continues one session per key, at most 169 characters. */
  sessionKey?: string;
  /** Opaque reply state, at most 4096 characters. Defaults to the empty string. */
  state?: string;
  text: string;
}

/** Passed to the live app's reply export, rather than fetch. */
export interface AppReplyMessage {
  fileIds: string[];
  runId: string;
  state: string;
  status: "finished" | "failed" | "cancelled" | "interrupted";
  text: string;
}

/** For R2.13 and R2.14: the per-visitor limit and the `artifact_views` row on every call. Filled by the gateway from the request. */
export interface AppRequestMeta {
  ipPrefix: string | null;
  place: string | null;
  userAgent: string | null;
  visitorHash: string;
}

export interface AppHostProps {
  artifactId: string;
  meta: AppRequestMeta;
  versionId: string;
  viewer: AppHostViewer;
  workspaceId: string;
}

/** Props of the `globalOutbound` entrypoint. Ids only, no host list: the loader config is cached per version and approvals land after it loads. */
export interface AppOutboundProps {
  artifactId: string;
  versionId: string;
  workspaceId: string;
}

export type StorageArea = "viewer" | "shared";

/** The `env.AGENTUM` an app server sees. Every call is an RPC to `AppHost`. Values are JSON text, so the app calls JSON.stringify and parse. */
export interface AgentumHost {
  /** A granted read-only tool, by `<serverKey>/<tool>`. */
  callTool: (toolKey: string, args: unknown) => Promise<unknown>;
  deleteItem: (area: StorageArea, key: string) => Promise<void>;
  getItem: (area: StorageArea, key: string) => Promise<string | null>;
  listItems: (
    area: StorageArea,
    prefix?: string,
    limit?: number
  ) => Promise<{ key: string; value: string }[]>;
  /** Refuses with `forbidden` when the viewer may not write the area, and `quota_exceeded` above the cap. */
  setItem: (area: StorageArea, key: string, value: string) => Promise<void>;
  startRun: (input: AppStartRunInput) => Promise<{ runId: string }>;
  whoami: () => Promise<{
    dataMode: "snapshot" | "live" | null;
    viewer: AppHostViewer["kind"];
  }>;
}

/** Errors cross RPC as `Error` with the code as the `message` prefix (`quota_exceeded: …`). */
export type AppErrorCode =
  | "forbidden"
  | "quota_exceeded"
  | "not_granted"
  | "rate_limited"
  | "too_large";

/** `viewerKey` is `u:<userId>` for members and `l:<shareId>` for link holders. */
export interface AppStoreScope {
  area: StorageArea;
  artifactId: string;
  viewerKey: string;
}

/** What B.3's store implements. The only place that touches the Durable Object. */
export interface AppStorePort {
  delete: (scope: AppStoreScope, key: string) => Promise<void>;
  get: (scope: AppStoreScope, key: string) => Promise<string | null>;
  list: (
    scope: AppStoreScope,
    prefix: string,
    limit: number
  ) => Promise<{ key: string; value: string }[]>;
  set: (scope: AppStoreScope, key: string, value: string) => Promise<void>;
}
