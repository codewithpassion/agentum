/** R2 key of a version's manifest. */
export const manifestKey = (workspaceId: string, versionId: string): string =>
  `${workspaceId}/artifact-manifests/${versionId}.json`;

/** R2 key of a content-addressed file. */
export const blobKey = (workspaceId: string, sha256: string): string =>
  `${workspaceId}/artifact-blobs/${sha256}`;
