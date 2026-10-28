// biome-ignore-all lint/suspicious/useAwait: Captured in-memory ports implement production async interfaces.
import { expect, test } from "bun:test";
import { artifacts } from "@repo/db/schema/artifacts";
import { files } from "@repo/db/schema/files";
import { artifactMembers } from "@repo/db/schema/live-artifacts";
import { runs } from "@repo/db/schema/runs";
import { createLiveArtifactsService } from "@repo/services/live-artifacts/service";
import { eq } from "drizzle-orm";
import { principals } from "../../../../../packages/services/src/artifacts/test-harness";
import { png, setup } from "./image-setup.test";

test("real create codec ingests inline/reference images once, stores exact ownership and publishes copied image bytes", async () => {
  const h = setup();
  const result = await h.service.createDocument(principals.owner, {
    markdown:
      "![one](https://images.example.test/photo)\n\n![two][pic]\n\n[pic]: https://images.example.test/photo\n\n`![code](https://unfetched.test/code)`\n\n<script>bad()</script>",
    title: "Images",
  });
  expect(h.requests).toEqual(["https://images.example.test/photo"]);
  const exported = await h.service.exportMarkdown(principals.owner, {
    artifactId: result.artifactId,
  });
  const [file] = h.db.select().from(files).all();
  if (!file) {
    throw new Error("Missing committed image file");
  }
  expect(exported.markdown).toContain(`/files/${file.id}`);
  expect(exported.markdown).not.toContain("https://images.example.test");
  expect(exported.markdown).toContain("https://unfetched.test/code");
  expect([...h.blobs.objects.keys()]).toContain(file.r2Key);
  expect(
    await h.service.ownBlobUrls(principals.owner, {
      artifactId: result.artifactId,
    })
  ).toEqual({ urls: [`/files/${file.id}`] });
  expect(result.files).toBe(4);
  expect(h.state().files).toBe(1);
});

test("actual static doc conversion ingests external images into the new artifact's ownership", async () => {
  const h = setup();
  const staticDoc = await harnessDoc(
    h,
    "![image](https://images.example.test/photo)"
  );
  const created = await h.service.convertDoc(principals.owner, {
    artifactId: staticDoc.artifactId,
  });
  expect(h.requests).toHaveLength(1);
  expect(
    (
      await h.service.ownBlobUrls(principals.owner, {
        artifactId: created.artifactId,
      })
    ).urls
  ).toHaveLength(1);
  expect(
    h.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, created.artifactId))
      .get()?.convertedFromId
  ).toBe(staticDoc.artifactId);
});

const harnessDoc = (h: ReturnType<typeof setup>, markdown: string) =>
  h.staticArtifacts.create(principals.owner, {
    entry: "index.md",
    files: [{ path: "index.md", text: markdown }],
    kind: "doc",
    title: "Static source",
  });

for (const url of [
  "https://images.example.test/denied",
  "https://images.example.test/redirect",
  "https://127.0.0.1/private",
]) {
  test(`failed import refuses publication and cleans prior staged images: ${url}`, async () => {
    const h = setup();
    const before = h.state();
    await expect(
      h.service.createDocument(principals.owner, {
        markdown: `![stored](https://images.example.test/good)\n\n![refused](${url})`,
        title: "Refused",
      })
    ).rejects.toThrow();
    expect(h.state()).toEqual(before);
    expect(h.requests).not.toContain("https://127.0.0.1/private");
  });
}

test("aggregate unique-image count and bytes are bounded and fully cleaned", async () => {
  const h = setup();
  await expect(
    h.service.createDocument(principals.owner, {
      markdown: Array.from(
        { length: 17 },
        (_, index) => `![${index}](https://images.example.test/${index})`
      ).join("\n\n"),
      title: "Too many",
    })
  ).rejects.toThrow("import limits");
  expect(h.requests).toHaveLength(16);
  expect(h.state()).toEqual({
    artifacts: 0,
    files: 0,
    imageObjects: 0,
    versions: 0,
  });
  h.deps.externalImageFetch = async () => {
    const body = new Uint8Array(5 * 1024 * 1024);
    body.set(png);
    return new Response(body, { headers: { "Content-Type": "image/png" } });
  };
  await expect(
    createLiveArtifactsService(h.deps).createDocument(principals.owner, {
      markdown:
        "![a](https://images.example.test/a)\n\n![b](https://images.example.test/b)",
      title: "Too large",
    })
  ).rejects.toThrow();
  expect(h.state()).toEqual({
    artifacts: 0,
    files: 0,
    imageObjects: 0,
    versions: 0,
  });
});

test("conversion rechecks source authority after fetch and writes no ownership on revocation", async () => {
  const h = setup();
  const staticDoc = await harnessDoc(
    h,
    "![image](https://images.example.test/photo)"
  );
  h.db
    .insert(artifactMembers)
    .values({
      artifactId: staticDoc.artifactId,
      createdAt: "2026-10-28T00:00:00Z",
      createdBy: "u1",
      id: "editor",
      principalKind: "user",
      role: "editor",
      userId: "u2",
      workspaceId: "w1",
    })
    .run();
  h.deps.externalImageFetch = async () => {
    h.db
      .update(artifactMembers)
      .set({ revokedAt: "2026-10-28T00:00:00Z" })
      .where(eq(artifactMembers.id, "editor"))
      .run();
    return new Response(png, { headers: { "Content-Type": "image/png" } });
  };
  const before = h.state();
  await expect(
    createLiveArtifactsService(h.deps).convertDoc(principals.stranger, {
      artifactId: staticDoc.artifactId,
    })
  ).rejects.toThrow();
  expect(h.state()).toEqual(before);
});

test("publication transaction failure cleans private file blobs and ownership; no file rows commit", async () => {
  const h = setup();
  const before = h.state();
  h.deps.atomic = async () => {
    expect(h.db.select().from(files).all()).toEqual([]);
    throw new Error("fixture commit failure");
  };
  await expect(
    createLiveArtifactsService(h.deps).createDocument(principals.owner, {
      markdown: "![image](https://images.example.test/photo)",
      title: "Atomic",
    })
  ).rejects.toThrow("fixture commit failure");
  expect(h.state()).toEqual(before);
});

test("scoped guest-origin run refuses creation before image transport, including scope changed during I/O", async () => {
  const h = setup();
  const existing = await h.service.createDocument(principals.owner, {
    title: "Scope target",
  });
  const before = h.state();
  const input = {
    markdown: "![image](https://images.example.test/photo)",
    title: "Scoped",
  };
  h.db
    .update(runs)
    .set({ scopeArtifactId: existing.artifactId })
    .where(eq(runs.id, principals.agentOne.runId))
    .run();
  await expect(
    h.service.createDocument(principals.agentOne, input)
  ).rejects.toThrow();
  expect(h.requests).toEqual([]);
  h.db
    .update(runs)
    .set({ scopeArtifactId: null })
    .where(eq(runs.id, principals.agentOne.runId))
    .run();
  h.deps.externalImageFetch = async () => {
    h.db
      .update(runs)
      .set({ scopeArtifactId: existing.artifactId })
      .where(eq(runs.id, principals.agentOne.runId))
      .run();
    return new Response(png, { headers: { "Content-Type": "image/png" } });
  };
  await expect(
    createLiveArtifactsService(h.deps).createDocument(
      principals.agentOne,
      input
    )
  ).rejects.toThrow();
  expect(h.state()).toEqual(before);
});

test("aggregate import deadline refuses an over-time captured fetch without publishing", async () => {
  const h = setup();
  const original = Date.now;
  let elapsed = 0;
  const start = original();
  Date.now = () => start + elapsed;
  try {
    h.deps.externalImageFetch = async () => {
      elapsed = 30_001;
      return new Response(png, { headers: { "Content-Type": "image/png" } });
    };
    await expect(
      createLiveArtifactsService(h.deps).createDocument(principals.owner, {
        markdown: "![image](https://images.example.test/photo)",
        title: "Deadline",
      })
    ).rejects.toThrow("import limits");
    expect(h.state()).toEqual({
      artifacts: 0,
      files: 0,
      imageObjects: 0,
      versions: 0,
    });
  } finally {
    Date.now = original;
  }
});

test("conversion rechecks access immediately before transaction, after ownership storage", async () => {
  const h = setup();
  const staticDoc = await harnessDoc(
    h,
    "![image](https://images.example.test/photo)"
  );
  h.db
    .insert(artifactMembers)
    .values({
      artifactId: staticDoc.artifactId,
      createdAt: "2026-10-28T00:00:00Z",
      createdBy: "u1",
      id: "editor",
      principalKind: "user",
      role: "editor",
      userId: "u2",
      workspaceId: "w1",
    })
    .run();
  const originalPut = h.blobs.put;
  h.deps.blobs = {
    ...h.blobs,
    put: async (key, body, options) => {
      const result = await originalPut(key, body, options);
      if (key.endsWith("/images.json")) {
        h.db
          .update(artifactMembers)
          .set({ revokedAt: "2026-10-28T00:00:00Z" })
          .where(eq(artifactMembers.id, "editor"))
          .run();
      }
      return result;
    },
  };
  const before = h.state();
  await expect(
    createLiveArtifactsService(h.deps).convertDoc(principals.stranger, {
      artifactId: staticDoc.artifactId,
    })
  ).rejects.toThrow();
  expect(h.state()).toEqual(before);
});

test("ownership write failure rejects content and deletes staged file bytes", async () => {
  const h = setup();
  h.deps.blobs = {
    ...h.blobs,
    put: async (key, bytes, options) =>
      key.endsWith("/images.json") ? null : h.blobs.put(key, bytes, options),
  };
  const before = h.state();
  await expect(
    createLiveArtifactsService(h.deps).createDocument(principals.owner, {
      markdown: "![image](https://images.example.test/photo)",
      title: "No ownership",
    })
  ).rejects.toThrow("ownership storage");
  expect(h.state()).toEqual(before);
});

test("lost commit acknowledgement preserves already accepted image rows, bytes and ownership", async () => {
  const h = setup();
  h.deps.atomic = async (statements) => {
    await h.atomic(statements);
    throw new Error("lost commit acknowledgement");
  };
  await expect(
    createLiveArtifactsService(h.deps).createDocument(principals.owner, {
      markdown: "![image](https://images.example.test/photo)",
      title: "Accepted before lost ack",
    })
  ).rejects.toThrow("lost commit acknowledgement");
  const [created] = h.db.select().from(artifacts).all();
  const [file] = h.db.select().from(files).all();
  if (!(created && file)) {
    throw new Error("Missing committed ownership");
  }
  expect(h.blobs.objects.has(file.r2Key)).toBe(true);
  expect(
    (await h.service.ownBlobUrls(principals.owner, { artifactId: created.id }))
      .urls
  ).toEqual([`/files/${file.id}`]);
  expect(
    (
      await h.service.exportMarkdown(principals.owner, {
        artifactId: created.id,
      })
    ).markdown
  ).toContain(`/files/${file.id}`);
});
