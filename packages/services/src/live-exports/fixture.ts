/** biome-ignore-all lint/suspicious/useAwait: Async boundary fixtures retain production port signatures. */
/** biome-ignore-all lint/performance/noAwaitInLoops: Sequential lifecycle cases mutate isolated authority and resource fixtures. */
import { artifacts } from "@repo/db/schema/artifacts";
import { files as fileRows } from "@repo/db/schema/files";
import { eq } from "drizzle-orm";
import {
  deckFixture,
  docFixture,
  png,
} from "../../../live-export/src/fixtures/content";
import { harness, principals } from "../artifacts/test-harness";
import { createFilesService } from "../files";
import { memoryFileBlobs } from "../files/memory";
import { systemClock } from "../runs/types";
import { createLiveExportsService } from "./service";

export async function exportHarness(kind: "document" | "deck" = "document") {
  const h = harness();
  const artifactId = crypto.randomUUID();
  h.db
    .insert(artifacts)
    .values({
      audience: "private",
      createdAt: new Date().toISOString(),
      createdById: "u1",
      createdByKind: "user",
      id: artifactId,
      kind,
      ownerUserId: "u1",
      title: 'Report "Q" / résumé',
      updatedAt: new Date().toISOString(),
      workspaceId: "w1",
    })
    .run();
  const blobs = memoryFileBlobs();
  const files = createFilesService({ blobs, clock: systemClock, db: h.db });
  const file = await files.upload(principals.owner, {
    body: new Blob([new Uint8Array(png)]),
    mime: "image/png",
    name: "own.png",
  });
  h.db
    .update(fileRows)
    .set({ id: "image", r2Key: "w1/files/image" })
    .where(eq(fileRows.id, file.id))
    .run();
  const stored = blobs.objects.get(`w1/files/${file.id}`);
  if (!stored) {
    throw new Error("Missing fixture PNG");
  }
  blobs.objects.set("w1/files/image", stored);
  file.id = "image";
  const state = kind === "document" ? docFixture() : deckFixture();
  const urls = new Set(["/files/image"]);
  let calls = 0;
  let reads = 0;
  const deps = {
    clock: systemClock,
    db: h.db,
    files: {
      describe: async (
        principal: Parameters<typeof files.describe>[0],
        ids: readonly string[]
      ) => (ids[0] === "image" ? files.describe(principal, [file.id]) : []),
      download: async (
        principal: Parameters<typeof files.download>[0],
        id: string
      ) => {
        reads += 1;
        if (id !== "image") {
          throw new Error("foreign asset");
        }
        return files.download(principal, file.id);
      },
    },
    live: { ownBlobUrls: async () => ({ urls: [...urls] }) },
    rooms: {
      snapshot: async () => {
        calls += 1;
        return { revision: 17, state };
      },
    },
  };
  return {
    ...h,
    artifactId,
    blobs,
    counts: () => ({ calls, reads }),
    deps,
    file,
    service: createLiveExportsService(deps),
    state,
    urls,
  };
}
