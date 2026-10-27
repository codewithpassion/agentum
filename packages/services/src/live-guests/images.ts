import type { Database } from "@repo/db";
import type { Atomic } from "@repo/db/atomic";
import { guestArtifactWriteGuard } from "@repo/db/live-guests";
import { files } from "@repo/db/schema/files";
import { and, eq } from "drizzle-orm";
import { ulid } from "ulidx";
import { hashToken } from "../crypto.ts";
import { ServiceError } from "../errors.ts";
import type { FileBlobs } from "../files.ts";
import { imageMime } from "../live-artifacts/image-mime.ts";
import type { Clock } from "../runs/types.ts";
import { createGuestArtifacts, type GuestCredential } from "./artifacts.ts";

const SEPARATOR = /[\\/]/;
const CONTROL = /\p{Cc}/gu;

export const createGuestImages = (deps: {
  db: Database;
  atomic: Atomic;
  clock: Clock;
  guestsOff: () => boolean;
  blobs: FileBlobs;
  policy: (scope: {
    workspaceId: string;
    artifactId: string;
  }) => Promise<string[]>;
  register: (
    scope: { workspaceId: string; artifactId: string },
    fileId: string
  ) => Promise<void>;
}) => {
  const access = createGuestArtifacts(deps);
  const denied = () =>
    new ServiceError("not_found", "Guest access unavailable");
  return {
    async read(input: GuestCredential, fileId: string) {
      const grant = await access.current(input);
      if (!(await deps.policy(grant)).includes(`/files/${fileId}`)) {
        throw denied();
      }
      const [file] = await deps.db
        .select()
        .from(files)
        .where(
          and(eq(files.id, fileId), eq(files.workspaceId, grant.workspaceId))
        )
        .limit(1);
      if (
        !(
          file &&
          [
            "image/png",
            "image/jpeg",
            "image/gif",
            "image/webp",
            "image/avif",
          ].includes(file.mime)
        )
      ) {
        throw denied();
      }
      const body = await deps.blobs.get(file.r2Key);
      await access.current(input);
      if (!body) {
        throw denied();
      }
      return { body, mime: file.mime };
    },
    async upload(input: GuestCredential, body: Blob, name: string) {
      const grant = await access.current(input);
      if (
        grant.role !== "editor" ||
        body.size < 12 ||
        body.size > 8 * 1024 * 1024
      ) {
        throw denied();
      }
      const mime = await imageMime(body);
      const id = ulid();
      const key = `${grant.workspaceId}/files/${id}`;
      await deps.blobs.put(key, body, mime);
      await access.current(input);
      if (deps.guestsOff()) {
        throw denied();
      }
      await deps.atomic([
        guestArtifactWriteGuard(deps.db, {
          ...grant,
          at: deps.clock.now().toISOString(),
          tokenHash: await hashToken(input.sessionToken),
        }),
        deps.db.insert(files).values({
          createdAt: deps.clock.now().toISOString(),
          createdById: grant.guestId,
          createdByKind: "guest",
          id,
          mime,
          name:
            name.split(SEPARATOR).at(-1)?.replace(CONTROL, "").slice(0, 200) ||
            "image",
          r2Key: key,
          size: body.size,
          source: "upload",
          workspaceId: grant.workspaceId,
        }),
      ]);
      await deps.register(grant, id);
      await access.current(input);
      return {
        guestUrl: `/api/guest/artifacts/${grant.artifactId}/files/${id}`,
        url: `/files/${id}`,
      };
    },
  };
};
