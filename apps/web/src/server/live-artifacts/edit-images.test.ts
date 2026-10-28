import { expect, test } from "bun:test";
import { files } from "@repo/db/schema/files";
import { runs } from "@repo/db/schema/runs";
import { eq } from "drizzle-orm";
import { principals } from "../../../../../packages/services/src/artifacts/test-harness";
import { setup } from "./image-setup.test";

const FILE_PATH = /^\/files\/[A-Za-z0-9_-]+$/;
const photo = "https://images.example.test/photo";
const agent = principals.agentOne;
const scopeRun = (h: ReturnType<typeof setup>, scope: string | null) =>
  h.db
    .update(runs)
    .set({ scopeArtifactId: scope })
    .where(eq(runs.id, agent.runId))
    .run();
const prepared = async () => {
  const h = setup();
  const created = await h.service.createDocument(agent, {
    markdown: "Hello",
    title: "Edit target",
  });
  return { ...h, artifactId: created.artifactId, before: h.state() };
};

test("staging fetches once, stores run-owned bytes under a stable change-derived id and retries do not refetch", async () => {
  const h = await prepared();
  const input = { artifactId: h.artifactId, changeId: "c1", urls: [photo] };
  const first = await h.service.roomStageEditImages(agent, input);
  const path = first.replacements[photo] ?? "";
  expect(path).toMatch(FILE_PATH);
  expect(h.requests).toEqual([photo]);
  const [row] = h.db.select().from(files).all();
  expect(row?.runId).toBe(agent.runId);
  expect(row?.createdByKind).toBe("agent");
  expect(`/files/${row?.id}`).toBe(path);
  expect(h.blobs.objects.has(row?.r2Key ?? "")).toBe(true);
  const retry = await h.service.roomStageEditImages(agent, input);
  expect(retry).toEqual(first);
  expect(h.requests).toHaveLength(1);
  expect(h.db.select().from(files).all()).toHaveLength(1);
  const other = await h.service.roomStageEditImages(agent, {
    ...input,
    changeId: "c2",
  });
  expect(other.replacements[photo]).not.toBe(path);
});

test("ownership is published only by the explicit publish step, exactly for the staged ids", async () => {
  const h = await prepared();
  const staged = await h.service.roomStageEditImages(agent, {
    artifactId: h.artifactId,
    changeId: "c1",
    urls: [photo],
  });
  const owned = () =>
    h.service.ownBlobUrls(principals.owner, { artifactId: h.artifactId });
  expect((await owned()).urls).toEqual([]);
  await h.service.roomPublishEditImages(agent, {
    artifactId: h.artifactId,
    ids: staged.ids,
  });
  expect((await owned()).urls).toEqual([staged.replacements[photo] ?? ""]);
  await h.service.roomPublishEditImages(agent, {
    artifactId: h.artifactId,
    ids: staged.ids,
  });
  expect((await owned()).urls).toHaveLength(1);
  await expect(
    h.service.roomPublishEditImages(agent, {
      artifactId: h.artifactId,
      ids: ["not-staged"],
    })
  ).rejects.toThrow();
});

test("scoped guest runs and callers without write access are refused before any transport", async () => {
  const h = await prepared();
  scopeRun(h, h.artifactId);
  await expect(
    h.service.roomStageEditImages(agent, {
      artifactId: h.artifactId,
      changeId: "c1",
      urls: [photo],
    })
  ).rejects.toThrow();
  scopeRun(h, null);
  await expect(
    h.service.roomStageEditImages(principals.stranger, {
      artifactId: h.artifactId,
      changeId: "c1",
      urls: [photo],
    })
  ).rejects.toThrow();
  await expect(
    h.service.roomStageEditImages(principals.agentTwo, {
      artifactId: h.artifactId,
      changeId: "c1",
      urls: [photo],
    })
  ).rejects.toThrow();
  expect(h.requests).toEqual([]);
  expect(h.state()).toEqual(h.before);
});

test("refused, denied and over-limit sources write nothing", async () => {
  const h = await prepared();
  const stage = (urls: string[]) =>
    h.service.roomStageEditImages(agent, {
      artifactId: h.artifactId,
      changeId: "c1",
      urls,
    });
  await expect(
    stage([photo, "https://images.example.test/denied"])
  ).rejects.toThrow();
  await expect(stage(["http://images.example.test/plain"])).rejects.toThrow();
  const many = Array.from(
    { length: 17 },
    (_, i) => `https://images.example.test/${i}`
  );
  const requests = h.requests.length;
  await expect(stage(many)).rejects.toThrow("import limits");
  expect(h.requests).toHaveLength(requests);
  expect(h.state()).toEqual(h.before);
});

test("access revoked during the fetch discards the fetched bytes and writes no row", async () => {
  const h = await prepared();
  // biome-ignore lint/suspicious/useAwait: captured transport matches the async port.
  h.deps.externalImageFetch = async () => {
    scopeRun(h, h.artifactId);
    return new Response(
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]),
      {
        headers: { "Content-Type": "image/png" },
      }
    );
  };
  const { createLiveArtifactsService } = await import(
    "@repo/services/live-artifacts/service"
  );
  const service = createLiveArtifactsService(h.deps);
  await expect(
    service.roomStageEditImages(agent, {
      artifactId: h.artifactId,
      changeId: "c1",
      urls: [photo],
    })
  ).rejects.toThrow();
  scopeRun(h, null);
  expect(h.state()).toEqual(h.before);
});

test("artifact quota counts every owned image plus the staged ones", async () => {
  const h = await prepared();
  const staged = await h.service.roomStageEditImages(agent, {
    artifactId: h.artifactId,
    changeId: "c1",
    urls: [photo],
  });
  await h.service.roomPublishEditImages(agent, {
    artifactId: h.artifactId,
    ids: staged.ids,
  });
  h.db
    .update(files)
    .set({ size: 16 * 1024 * 1024 })
    .run();
  await expect(
    h.service.roomStageEditImages(agent, {
      artifactId: h.artifactId,
      changeId: "c2",
      urls: ["https://images.example.test/second"],
    })
  ).rejects.toThrow("file limits");
  expect(h.db.select().from(files).all()).toHaveLength(1);
});

test("discard removes exactly the named run-owned rows, bytes and ownership", async () => {
  const h = await prepared();
  const keep = await h.service.roomStageEditImages(agent, {
    artifactId: h.artifactId,
    changeId: "keep",
    urls: [photo],
  });
  const drop = await h.service.roomStageEditImages(agent, {
    artifactId: h.artifactId,
    changeId: "drop",
    urls: ["https://images.example.test/other"],
  });
  await Promise.all(
    [keep, drop].map((staged) =>
      h.service.roomPublishEditImages(agent, {
        artifactId: h.artifactId,
        ids: staged.ids,
      })
    )
  );
  await h.service.roomDiscardEditImages(
    { artifactId: h.artifactId, workspaceId: agent.workspaceId },
    { ids: drop.ids, runId: agent.runId }
  );
  expect(
    h.db
      .select()
      .from(files)
      .all()
      .map((f) => f.id)
  ).toEqual(keep.ids);
  expect(
    (
      await h.service.ownBlobUrls(principals.owner, {
        artifactId: h.artifactId,
      })
    ).urls
  ).toEqual(Object.values(keep.replacements));
  await expect(
    h.service.roomDiscardEditImages(
      { artifactId: h.artifactId, workspaceId: agent.workspaceId },
      { ids: keep.ids, runId: "another-run" }
    )
  ).rejects.toThrow();
  expect(h.db.select().from(files).all()).toHaveLength(1);
});
