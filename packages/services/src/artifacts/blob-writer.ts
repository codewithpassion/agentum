import type { Database } from "@repo/db";
import { knownBlobSizes, workspaceBlobBytes } from "@repo/db/artifacts";
import { ARTIFACT_WORKSPACE_MAX_BYTES } from "@repo/db/shared";
import {
  type ArtifactManifest,
  artifactManifestSchema,
} from "@repo/protocol/artifacts";
import { ServiceError } from "../errors.ts";
import type { LibraryBlobs } from "../library.ts";

export interface ArtifactBlobFile {
  bytes: Uint8Array;
  contentType: string;
  path: string;
  sha256: string;
}
interface ArtifactManifestDraft {
  entry: string;
  files: { contentType: string; path: string; sha256: string; size: number }[];
  versionId: string;
}
export const blobKey = (workspaceId: string, sha256: string) =>
  `${workspaceId}/artifact-blobs/${sha256}`;
export const manifestKey = (workspaceId: string, versionId: string) =>
  `${workspaceId}/artifact-manifests/${versionId}.json`;
const invalid = (message: string) => new ServiceError("invalid", message);
const BLOB_WRITE_PARALLEL = 8;
const chunks = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
};

/** Shared content-addressed storage and quota rules for static versions and live checkpoints. */
export const createArtifactBlobWriter = ({
  db,
  blobs,
}: {
  db: Database;
  blobs: Pick<LibraryBlobs, "get" | "put">;
}) => {
  /** Refuses a write that would take the workspace's blobs over the quota. */
  const checkQuota = async (
    workspaceId: string,
    files: readonly ArtifactBlobFile[]
  ): Promise<Set<string>> => {
    const unique = new Map<string, number>();
    for (const file of files) {
      unique.set(file.sha256, file.bytes.byteLength);
    }
    const known = await knownBlobSizes(db, workspaceId, [...unique.keys()]);
    const fresh = new Set<string>();
    let freshBytes = 0;
    for (const [hash, size] of unique) {
      if (!known.has(hash)) {
        fresh.add(hash);
        freshBytes += size;
      }
    }
    const used = await workspaceBlobBytes(db, workspaceId);
    if (used + freshBytes > ARTIFACT_WORKSPACE_MAX_BYTES) {
      throw invalid("The workspace's artifact storage is full (1 GB)");
    }
    return fresh;
  };

  const writeBlobs = async (
    workspaceId: string,
    files: readonly ArtifactBlobFile[],
    fresh: ReadonlySet<string>
  ) => {
    const toWrite = new Map<string, Uint8Array>();
    for (const file of files) {
      if (fresh.has(file.sha256)) {
        toWrite.set(file.sha256, file.bytes);
      }
    }
    for (const batch of chunks([...toWrite], BLOB_WRITE_PARALLEL)) {
      // biome-ignore lint/performance/noAwaitInLoops: a few blobs at a time, not 200 at once
      await Promise.all(
        batch.map(([hash, bytes]) =>
          blobs.put(blobKey(workspaceId, hash), bytes)
        )
      );
    }
  };

  const writeManifest = async (
    workspaceId: string,
    draft: ArtifactManifestDraft
  ) => {
    const manifest: ArtifactManifest = {
      entry: draft.entry,
      files: Object.fromEntries(
        draft.files.map((file) => [
          file.path,
          {
            contentType: file.contentType,
            sha256: file.sha256,
            size: file.size,
          },
        ])
      ),
    };
    const checked = artifactManifestSchema.safeParse(manifest);
    if (!checked.success) {
      throw invalid(checked.error.issues[0]?.message ?? "Invalid artifact");
    }
    await blobs.put(
      manifestKey(workspaceId, draft.versionId),
      new TextEncoder().encode(JSON.stringify(checked.data))
    );
  };

  return { checkQuota, writeBlobs, writeManifest };
};
