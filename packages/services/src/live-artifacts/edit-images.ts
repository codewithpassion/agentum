/** External Markdown images for a guarded document edit. Called by the room
 * only after it admitted the edit's guards. Ids derive from the change id and
 * the URL, so a retried change finds its rows and never fetches twice. */
import { files } from "@repo/db/schema/files";
import { ARTIFACT_MAX_BYTES, ARTIFACT_MAX_FILES } from "@repo/db/shared";
import { and, eq, inArray } from "drizzle-orm";
import { ForbiddenError } from "../authz.ts";
import { ServiceError } from "../errors.ts";
import type { Principal } from "../workspaces.ts";
import {
  IMAGE_FILE_PATH,
  IMPORT_IMAGE_LIMITS,
  stageImportImages,
} from "./import-images.ts";
import type { LiveArtifactsDeps, LiveRoomScope, Member } from "./service.ts";

type Access = (
  principal: Principal,
  artifactId: string,
  write?: boolean
) => Promise<{
  member: Member;
  row: { id: string; workspaceId: string; kind: string };
}>;
const ID_PREFIX = "edit-";
const invalid = (message: string) => new ServiceError("invalid", message);
const manifestKey = (scope: LiveRoomScope) =>
  `${scope.workspaceId}/live-artifacts/${scope.artifactId}/images.json`;
const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
const fileId = async (changeId: string, url: string) =>
  `${ID_PREFIX}${hex(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${changeId}\n${url}`)
    )
  ).slice(0, 40)}`;

export const createEditImagesModule = (
  deps: LiveArtifactsDeps & {
    access: Access;
    requireUnscoped: (principal: Principal, action: string) => Promise<void>;
  }
) => {
  const { db, blobs, clock } = deps;
  const writer = async (principal: Principal, artifactId: string) => {
    await deps.requireUnscoped(principal, "liveArtifacts.editImages");
    const { member, row } = await deps.access(principal, artifactId, true);
    if (member.kind !== "run" || row.kind !== "document") {
      throw new ForbiddenError("liveArtifacts.editImages");
    }
    return { member, row };
  };
  const readManifest = async (scope: LiveRoomScope) => {
    const stored = await blobs.get(manifestKey(scope));
    const urls: unknown = stored
      ? JSON.parse(new TextDecoder().decode(stored.bytes))
      : [];
    if (
      !Array.isArray(urls) ||
      urls.some((u) => typeof u !== "string" || !IMAGE_FILE_PATH.test(u))
    ) {
      throw invalid("Invalid image manifest");
    }
    return urls as string[];
  };
  const writeManifest = async (scope: LiveRoomScope, urls: string[]) => {
    const written = await blobs.put(
      manifestKey(scope),
      new TextEncoder().encode(JSON.stringify(urls))
    );
    if (!written) {
      throw invalid("Image ownership storage failed");
    }
  };
  const owned = (workspaceId: string, ids: string[]) =>
    ids.length
      ? db
          .select()
          .from(files)
          .where(
            and(eq(files.workspaceId, workspaceId), inArray(files.id, ids))
          )
      : Promise.resolve([]);
  return {
    /** Removes a failed change's staged rows, bytes and ownership. The room
     * calls it only when no accepted change or suggestion uses the images. */
    async roomDiscardEditImages(
      scope: LiveRoomScope,
      input: { ids: string[]; runId: string }
    ) {
      const rows = await owned(scope.workspaceId, input.ids);
      if (
        rows.some(
          (file) => file.runId !== input.runId || !file.id.startsWith(ID_PREFIX)
        )
      ) {
        throw new ForbiddenError("liveArtifacts.editImages");
      }
      const gone = new Set(rows.map((file) => `/files/${file.id}`));
      const prior = await readManifest(scope);
      if (prior.some((path) => gone.has(path))) {
        await writeManifest(
          scope,
          prior.filter((path) => !gone.has(path))
        );
      }
      await Promise.all(
        rows.map((file) => deps.imageBlobs?.delete(file.r2Key))
      );
      if (rows.length) {
        await db.delete(files).where(
          and(
            eq(files.workspaceId, scope.workspaceId),
            inArray(
              files.id,
              rows.map((file) => file.id)
            )
          )
        );
      }
    },
    /** Adds the staged files to the artifact's image ownership manifest. The
     * caller serializes this with every other manifest writer. */
    async roomPublishEditImages(
      principal: Principal,
      input: { artifactId: string; ids: string[] }
    ) {
      const { member, row } = await writer(principal, input.artifactId);
      const scope = { artifactId: row.id, workspaceId: row.workspaceId };
      const rows = await owned(row.workspaceId, input.ids);
      if (
        member.kind !== "run" ||
        rows.length !== new Set(input.ids).size ||
        rows.some((file) => file.runId !== member.runId)
      ) {
        throw invalid("Image not found");
      }
      const prior = await readManifest(scope);
      await writeManifest(scope, [
        ...new Set([...prior, ...input.ids.map((id) => `/files/${id}`)]),
      ]);
    },
    /** Fetches and stores the images as run-owned file rows. Ownership of the
     * artifact is a separate publish step, so nothing is accepted yet. */
    async roomStageEditImages(
      principal: Principal,
      input: { artifactId: string; changeId: string; urls: string[] }
    ) {
      const { member, row } = await writer(principal, input.artifactId);
      const urls = [...new Set(input.urls)];
      if (!(input.changeId && urls.length)) {
        throw invalid("An edit with images needs a change id and URLs");
      }
      if (member.kind !== "run") {
        throw new ForbiddenError("liveArtifacts.editImages");
      }
      if (urls.length > IMPORT_IMAGE_LIMITS.count) {
        throw invalid(
          "Markdown images exceed import limits (16 unique images, 8 MiB, 30 seconds)"
        );
      }
      const scope = { artifactId: row.id, workspaceId: row.workspaceId };
      const ids = new Map(
        await Promise.all(
          urls.map(
            async (url) => [url, await fileId(input.changeId, url)] as const
          )
        )
      );
      const prior = await owned(row.workspaceId, [...ids.values()]);
      if (prior.some((file) => file.runId !== member.runId)) {
        throw invalid("Image id collision");
      }
      const fresh = urls.filter(
        (url) => !prior.some((file) => file.id === ids.get(url))
      );
      const staging = stageImportImages({
        authorize: async () => {
          await writer(principal, input.artifactId);
        },
        clock,
        fetcher: deps.externalImageFetch,
        fileBlobs: deps.imageBlobs,
        manifests: blobs,
        member,
        newId: (url) => {
          const id = ids.get(url);
          if (!id) {
            throw invalid("Unknown image");
          }
          return id;
        },
        scope,
      });
      try {
        for (const url of fresh) {
          // biome-ignore lint/performance/noAwaitInLoops: sequential fetches share the aggregate byte, count and time bounds.
          await staging.resolve(url);
        }
        staging.checkDeadline();
        const manifest = await readManifest(scope);
        const known = await owned(
          row.workspaceId,
          manifest.map((path) => path.slice("/files/".length))
        );
        const all = new Map(
          [...known, ...prior, ...staging.rows].map((file) => [file.id, file])
        );
        const bytes = [...all.values()].reduce((sum, f) => sum + f.size, 0);
        if (bytes > ARTIFACT_MAX_BYTES || all.size + 3 > ARTIFACT_MAX_FILES) {
          throw invalid("Images exceed artifact file limits");
        }
        await writer(principal, input.artifactId);
        if (staging.rows.length) {
          await db.insert(files).values(staging.rows).onConflictDoNothing();
        }
      } catch (error) {
        await staging.cleanup();
        throw error;
      }
      return {
        ids: [...ids.values()],
        replacements: Object.fromEntries(
          [...ids].map(([url, id]) => [url, `/files/${id}`])
        ),
      };
    },
  };
};
