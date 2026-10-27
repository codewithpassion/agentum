import { describe, expect, test } from "bun:test";
import { workspaceBlobBytes } from "@repo/db/artifacts";
import {
  artifacts,
  artifactVersionFiles,
  artifactVersions,
} from "@repo/db/schema/artifacts";
import { events } from "@repo/db/schema/events";
import { ARTIFACT_WORKSPACE_MAX_BYTES } from "@repo/db/shared";
import { eq } from "drizzle-orm";
import { createLiveArtifactsService } from "../live-artifacts/service.ts";
import { rethrowArtifactQuotaError } from "./blob-writer.ts";
import { bytes, harness, principals } from "./test-harness.ts";

const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const setup = async () => {
  const h = harness();
  const liveService = () =>
    createLiveArtifactsService({
      ...h,
      artifacts: h.service,
      clock: {
        now: () => new Date("2026-10-27T00:00:00Z"),
        sleep: async () => undefined,
      },
      content: {
        exportDocument: ({ state }) => {
          const markdown = new TextDecoder().decode(state);
          return Promise.resolve({ html: `<p>${markdown}</p>`, markdown });
        },
        importMarkdown: async (markdown) => ({
          revision: 0,
          state: bytes(markdown),
        }),
        loadDocument: async (state) => ({ revision: 0, state }),
      },
      identity: async () => ({ color: "#123abc", name: "Owner" }),
      rooms: {
        refresh: async () => undefined,
        restore: async () => ({ revision: 2, state: bytes("r".repeat(40)) }),
        url: () => "/room",
      },
      ticketKey: "quota-test-key",
    });
  const live = liveService();
  const rival = liveService();
  const seed = await h.service.create(principals.owner, {
    files: [{ path: "index.md", text: "ballast" }],
    kind: "doc",
    title: "Metadata ballast",
  });
  const a = await live.createDocument(principals.owner, {
    markdown: "initial-a",
    title: "A",
  });
  const b = await live.createDocument(principals.owner, {
    markdown: "initial-b",
    title: "B",
  });
  const used = await workspaceBlobBytes(h.db, "w1");
  // Fixture metadata fills storage without allocating a gigabyte.
  h.db
    .update(artifactVersionFiles)
    .set({
      size: ARTIFACT_WORKSPACE_MAX_BYTES - used - 150 + bytes("ballast").length,
    })
    .where(eq(artifactVersionFiles.versionId, seed.versionId))
    .run();
  const snapshot = () => ({
    artifacts: h.db.select().from(artifacts).all(),
    events: h.db.select().from(events).all(),
    files: h.db.select().from(artifactVersionFiles).all(),
    versions: h.db.select().from(artifactVersions).all(),
  });
  const holdNextManifest = () => {
    const entered = deferred();
    const release = deferred();
    const { put } = h.blobs;
    let held = false;
    h.blobs.put = async (key, data) => {
      if (!held && key.includes("/artifact-manifests/")) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return await put(key, data);
    };
    return { entered: entered.promise, release: release.resolve };
  };
  const createLive = (text: string, publisher = live) =>
    publisher.createDocument(principals.owner, {
      markdown: text.repeat(40),
      title: text,
    });
  const checkpoint = (artifactId: string, text: string, publisher = live) =>
    publisher.checkpoint(principals.owner, {
      artifactId,
      revision: 1,
      state: bytes(text.repeat(40)),
    });
  return {
    ...h,
    a,
    b,
    checkpoint,
    createLive,
    holdNextManifest,
    live,
    rival,
    seed,
    snapshot,
  };
};

describe("transactional workspace artifact quota", () => {
  for (const scenario of [
    "static/live create",
    "live/live create",
    "static update/live checkpoint",
    "live/live checkpoint",
    "live restore/live checkpoint",
  ] as const) {
    test(`${scenario}: stale preflight loser rolls back every DB mutation`, async () => {
      const h = await setup();
      const gate = h.holdNextManifest();
      let slow: Promise<unknown>;
      if (scenario === "static/live create") {
        slow = h.service.create(principals.owner, {
          files: [{ path: "index.md", text: "s".repeat(100) }],
          kind: "doc",
          title: "Slow",
        });
      } else if (scenario === "static update/live checkpoint") {
        slow = h.service.update(principals.owner, {
          artifactId: h.seed.artifactId,
          baseVersion: 1,
          files: [{ path: "index.md", text: "s".repeat(100) }],
          message: "Update",
        });
      } else if (scenario === "live restore/live checkpoint") {
        slow = h.live.restore(principals.owner, {
          artifactId: h.a.artifactId,
          version: 1,
        });
      } else {
        slow =
          scenario === "live/live checkpoint"
            ? h.checkpoint(h.a.artifactId, "s")
            : h.createLive("s");
      }
      const outcome = slow.then(
        () => null,
        (error: unknown) => error
      );
      await gate.entered;
      if (scenario.includes("checkpoint")) {
        await h.checkpoint(h.b.artifactId, "w", h.rival);
      } else {
        await h.createLive("w", h.rival);
      }
      const before = h.snapshot();
      gate.release();
      expect(await outcome).toMatchObject({
        code: "invalid",
        message: "The workspace's artifact storage is full (1 GB)",
      });
      expect(h.snapshot()).toEqual(before);
      expect(await workspaceBlobBytes(h.db, "w1")).toBeLessThanOrEqual(
        ARTIFACT_WORKSPACE_MAX_BYTES
      );
    });
  }

  test("competing same-content publications share capacity across paths and versions", async () => {
    const h = await setup();
    const gate = h.holdNextManifest();
    const slow = h.createLive("x");
    await gate.entered;
    await h.createLive("x", h.rival);
    const used = await workspaceBlobBytes(h.db, "w1");
    gate.release();
    await slow;
    expect(await workspaceBlobBytes(h.db, "w1")).toBe(used);
    await h.service.create(principals.owner, {
      files: [
        { path: "index.md", text: "x".repeat(40) },
        { path: "copy.md", text: "x".repeat(40) },
      ],
      kind: "doc",
      title: "Duplicate paths",
    });
    expect(await workspaceBlobBytes(h.db, "w1")).toBe(used);
  });

  test("static restore reuses existing hashes at exactly the quota", async () => {
    const h = await setup();
    const [ballast] = h.db
      .select()
      .from(artifactVersionFiles)
      .where(eq(artifactVersionFiles.versionId, h.seed.versionId))
      .all();
    if (!ballast) {
      throw new Error("Missing ballast");
    }
    h.db
      .update(artifactVersionFiles)
      .set({ size: ballast.size + 150 })
      .where(eq(artifactVersionFiles.versionId, h.seed.versionId))
      .run();
    expect(await workspaceBlobBytes(h.db, "w1")).toBe(
      ARTIFACT_WORKSPACE_MAX_BYTES
    );
    const target = await h.service.create(principals.owner, {
      files: [{ path: "index.md", text: "initial-a" }],
      kind: "doc",
      title: "Existing content",
    });
    expect(
      await h.service.restore(principals.owner, target.artifactId, 1)
    ).toEqual({ version: 2 });
    expect(await workspaceBlobBytes(h.db, "w1")).toBe(
      ARTIFACT_WORKSPACE_MAX_BYTES
    );
  });

  test("wrapped D1 quota assertion errors are translated; unrelated failures propagate", () => {
    expect(() =>
      rethrowArtifactQuotaError(
        new Error("D1 batch", {
          cause: new Error(
            "NOT NULL constraint failed: artifact_versions.total_bytes: SQLITE_CONSTRAINT"
          ),
        })
      )
    ).toThrow("artifact storage is full");
    expect(() =>
      rethrowArtifactQuotaError(new Error("foreign key failure"))
    ).not.toThrow();
  });
});
