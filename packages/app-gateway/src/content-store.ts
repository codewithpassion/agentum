/** R2 key of a version's manifest. */
export const manifestKey = (workspaceId: string, versionId: string): string =>
  `${workspaceId}/artifact-manifests/${versionId}.json`;

/** R2 key of a content-addressed file. */
export const blobKey = (workspaceId: string, sha256: string): string =>
  `${workspaceId}/artifact-blobs/${sha256}`;

/** The slice of an R2 object the content route and the bundle reader read. `R2ObjectBody` satisfies it. */
export interface ContentObject {
  arrayBuffer: () => Promise<ArrayBuffer>;
  body: ReadableStream;
  size: number;
}

/** The slice of an R2 bucket they read. The `FILES` binding satisfies it. */
export interface ContentBucket {
  get: (key: string) => Promise<ContentObject | null>;
}
