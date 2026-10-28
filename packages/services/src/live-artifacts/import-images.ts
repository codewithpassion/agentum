/** Staged image rows join the artifact/version/quota transaction. Only unique,
 * privately named file blobs exist before commit; failures remove those bytes. */
import type { files } from "@repo/db/schema/files";
import { ulid } from "ulidx";
import { ServiceError } from "../errors.ts";
import type { FileBlobs } from "../files.ts";
import type { LibraryBlobs } from "../library.ts";
import type { Clock } from "../runs/types.ts";
import { fetchExternalImage, type ImageFetch } from "./external-image.ts";
import type { LiveRoomScope, Member } from "./service.ts";

export const IMAGE_FILE_PATH = /^\/files\/[A-Za-z0-9_-]+$/;
export type ImportImageRow = typeof files.$inferSelect;
const sourceOf = (member: Member) => {
  if (member.kind === "run") {
    return "run" as const;
  }
  return member.via === "slack" ? ("slack" as const) : ("upload" as const);
};

export const IMPORT_IMAGE_LIMITS = {
  bytes: 8 * 1024 * 1024,
  count: 16,
  milliseconds: 30_000,
} as const;
const invalid = () =>
  new ServiceError(
    "invalid",
    "Markdown images exceed import limits (16 unique images, 8 MiB, 30 seconds)"
  );
export function stageImportImages(input: {
  member: Member;
  scope: LiveRoomScope;
  clock: Clock;
  fetcher?: ImageFetch;
  fileBlobs?: Pick<FileBlobs, "put" | "delete">;
  manifests: Pick<LibraryBlobs, "put"> & Partial<Pick<LibraryBlobs, "delete">>;
  authorize: () => Promise<void>;
  /** Defaults to a fresh ulid. Guarded edits derive it so retries agree. */
  newId?: (url: string) => string;
}) {
  const rows: ImportImageRow[] = [];
  const resolved = new Map<string, string>();
  const keys: string[] = [];
  const manifest = `${input.scope.workspaceId}/live-artifacts/${input.scope.artifactId}/images.json`;
  const deadline = Date.now() + IMPORT_IMAGE_LIMITS.milliseconds;
  const signal = AbortSignal.timeout(IMPORT_IMAGE_LIMITS.milliseconds);
  let size = 0;
  let manifestWritten = false;
  return {
    checkDeadline() {
      if (!rows.length) {
        return;
      }
      if (Date.now() >= deadline) {
        throw invalid();
      }
      signal.throwIfAborted();
    },
    async cleanup() {
      // These keys are unique to this failed creation, never shared checkpoint blobs.
      const results = await Promise.allSettled([
        ...keys.map((key) => input.fileBlobs?.delete(key)),
        ...(manifestWritten ? [input.manifests.delete?.([manifest])] : []),
      ]);
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") {
        throw failed.reason;
      }
    },
    async publishOwnership() {
      if (!rows.length) {
        return;
      }
      await input.authorize();
      signal.throwIfAborted();
      manifestWritten = true;
      const written = await input.manifests.put(
        manifest,
        new TextEncoder().encode(
          JSON.stringify(rows.map((row) => `/files/${row.id}`))
        )
      );
      if (!written) {
        throw new ServiceError("invalid", "Image ownership storage failed");
      }
    },
    async resolve(url: string) {
      const prior = resolved.get(url);
      if (prior) {
        return prior;
      }
      if (!(input.fetcher && input.fileBlobs && input.manifests.delete)) {
        throw new ServiceError(
          "invalid",
          "Markdown image storage is unavailable"
        );
      }
      if (rows.length >= IMPORT_IMAGE_LIMITS.count || Date.now() >= deadline) {
        throw invalid();
      }
      await input.authorize();
      const body = await fetchExternalImage(url, input.fetcher, {
        deadline,
        maxBytes: IMPORT_IMAGE_LIMITS.bytes - size,
        signal,
      });
      size += body.size;
      if (size > IMPORT_IMAGE_LIMITS.bytes || Date.now() >= deadline) {
        throw invalid();
      }
      await input.authorize();
      const id = input.newId?.(url) ?? ulid();
      const r2Key = `${input.scope.workspaceId}/files/${id}`;
      keys.push(r2Key);
      await input.fileBlobs.put(r2Key, body, body.type);
      rows.push({
        createdAt: input.clock.now().toISOString(),
        createdById:
          input.member.kind === "user"
            ? input.member.userId
            : input.member.agentId,
        createdByKind: input.member.kind === "user" ? "user" : "agent",
        id,
        mime: body.type,
        name: "Imported image",
        r2Key,
        runId: input.member.kind === "run" ? input.member.runId : null,
        size: body.size,
        source: sourceOf(input.member),
        workspaceId: input.scope.workspaceId,
      });
      const path = `/files/${id}`;
      resolved.set(url, path);
      return path;
    },
    rows,
  };
}
