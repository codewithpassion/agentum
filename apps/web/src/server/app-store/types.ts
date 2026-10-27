// The contract of app storage (docs/v3/phase2-spike.md, "The `HM` interface").
// B.2's AppHost and B.5's storage procedures build to these types.

/** From the verified content token, never from app code. */
export type AppViewer =
  | { kind: "member"; userId: string }
  | { kind: "link"; shareId: string; dataMode: "snapshot" | "live" };

export type StorageArea = "viewer" | "shared";

export type AppErrorCode =
  | "forbidden"
  | "quota_exceeded"
  | "not_granted"
  | "rate_limited"
  | "too_large";

/** `viewerKey` is `u:<userId>` for members and `l:<shareId>` for link holders. In the `shared` area it is ignored. */
export interface AppStoreScope {
  area: StorageArea;
  artifactId: string;
  viewerKey: string;
}

export interface StoredItem {
  key: string;
  value: string;
}

/**
 * The only place that touches the AppStore Durable Object. The port does not
 * check `canWrite`: callers call it before every `set` and `delete`, or go
 * through `viewerStorage`, which does.
 */
export interface AppStorePort {
  delete: (scope: AppStoreScope, key: string) => Promise<void>;
  get: (scope: AppStoreScope, key: string) => Promise<string | null>;
  list: (
    scope: AppStoreScope,
    prefix: string,
    limit: number
  ) => Promise<StoredItem[]>;
  /** Throws `quota_exceeded` above the cap and `too_large` for an oversize key or value. */
  set: (scope: AppStoreScope, key: string, value: string) => Promise<void>;
  usage: (artifactId: string) => Promise<{ bytes: number; maxBytes: number }>;
  /** Empties the app's storage, for when the artifact is deleted. */
  wipe: (artifactId: string) => Promise<void>;
}
