/** biome-ignore-all lint/suspicious/useAwait: Async boundary fixtures retain production port signatures. */
/** biome-ignore-all lint/performance/noAwaitInLoops: Sequential lifecycle cases mutate isolated authority and resource fixtures. */

import { expect, test } from "bun:test";
import { artifacts } from "@repo/db/schema/artifacts";
import { files as fileRows } from "@repo/db/schema/files";
import { artifactMembers } from "@repo/db/schema/live-artifacts";
import { ExportError } from "@repo/live-export";
import { eq } from "drizzle-orm";
import { unzipSync } from "fflate";
import { principals } from "../artifacts/test-harness";
import { SYSTEM_PRINCIPAL } from "../workspaces";
import { exportHarness } from "./fixture";
import { createLiveExportsService, exportLimits } from "./service";

test("member exports use accepted room bytes, produce actual Office archives and never mutate state", async () => {
  for (const kind of ["document", "deck"] as const) {
    const h = await exportHarness(kind);
    const before = new Uint8Array(h.state);
    const result = await h.service.download(principals.owner, {
      artifactId: h.artifactId,
      format: kind === "deck" ? "pptx" : "docx",
    });
    const archive = unzipSync(result.bytes);
    const xml =
      archive[kind === "deck" ? "ppt/slides/slide1.xml" : "word/document.xml"];
    expect(xml).toBeDefined();
    expect(new TextDecoder().decode(xml)).toContain(
      kind === "deck" ? "Deck title" : "résumé"
    );
    expect(result.filename).not.toContain('"');
    expect(result.revision).toBe(17);
    expect(
      JSON.parse(decodeURIComponent(result.warnings)).length
    ).toBeGreaterThan(0);
    expect(h.state).toEqual(before);
    expect(h.counts()).toEqual({ calls: 1, reads: 1 });
  }
});

test("viewer/commenter/editor grants can export; expired/revoked/foreign/anonymous identities cannot", async () => {
  const h = await exportHarness();
  const input = { artifactId: h.artifactId, format: "docx" as const };
  for (const principal of [
    principals.stranger,
    principals.otherWorkspace,
    principals.agentOne,
    SYSTEM_PRINCIPAL,
  ]) {
    await expect(h.service.download(principal, input)).rejects.toBeDefined();
  }
  expect(h.counts()).toEqual({ calls: 0, reads: 0 });
  for (const role of ["viewer", "commenter", "editor"] as const) {
    h.db.delete(artifactMembers).run();
    h.db
      .insert(artifactMembers)
      .values({
        artifactId: h.artifactId,
        createdAt: new Date().toISOString(),
        createdBy: "u1",
        id: crypto.randomUUID(),
        principalKind: "user",
        role,
        userId: "u2",
        workspaceId: "w1",
      })
      .run();
    expect(
      (await h.service.download(principals.stranger, input)).bytes.length
    ).toBeGreaterThan(100);
  }
  h.db.update(artifactMembers).set({ expiresAt: "2000-01-01" }).run();
  await expect(
    h.service.download(principals.stranger, input)
  ).rejects.toBeDefined();
  h.db
    .update(artifactMembers)
    .set({ expiresAt: null, revokedAt: new Date().toISOString() })
    .run();
  await expect(
    h.service.download(principals.stranger, input)
  ).rejects.toBeDefined();
});

test("access revocation during capture or printing prevents delivery", async () => {
  const h = await exportHarness();
  const input = { artifactId: h.artifactId, format: "docx" as const };
  const revoked = createLiveExportsService({
    ...h.deps,
    rooms: {
      snapshot: async () => {
        h.db
          .update(artifacts)
          .set({ deletedAt: new Date().toISOString() })
          .where(eq(artifacts.id, h.artifactId))
          .run();
        return { revision: 18, state: h.state };
      },
    },
  });
  await expect(revoked.download(principals.owner, input)).rejects.toBeDefined();
  expect(h.counts().reads).toBe(0);
  h.db.update(artifacts).set({ deletedAt: null }).run();
  const print = createLiveExportsService({
    ...h.deps,
    printPDF: async () => {
      h.db.update(artifacts).set({ deletedAt: new Date().toISOString() }).run();
      return new TextEncoder().encode("%PDF-fixture");
    },
  });
  await expect(
    print.download(principals.owner, { ...input, format: "pdf" })
  ).rejects.toBeDefined();
});

test("own asset inventory is canonical, reread and never falls back to network; malformed and oversized assets refuse", async () => {
  const h = await exportHarness();
  const input = { artifactId: h.artifactId, format: "docx" as const };
  for (const url of [
    "https://169.254.169.254/x",
    "/files/../foreign",
    "/files/a?x=1",
  ]) {
    h.urls.add(url);
    await expect(
      h.service.download(principals.owner, input)
    ).rejects.toMatchObject({ code: "export_asset_inventory" });
    h.urls.delete(url);
  }
  let inventories = 0;
  const stale = createLiveExportsService({
    ...h.deps,
    live: {
      ownBlobUrls: async () => {
        inventories += 1;
        return { urls: inventories === 1 ? ["/files/image"] : [] };
      },
    },
  });
  await expect(stale.download(principals.owner, input)).rejects.toMatchObject({
    code: "export_asset_scope",
  });
  expect(h.counts().reads).toBe(0);
  const key = `w1/files/${h.file.id}`;
  h.blobs.objects.set(key, {
    bytes: new Uint8Array([1, 2, 3]),
    contentType: "image/png",
  });
  await expect(
    h.service.download(principals.owner, input)
  ).rejects.toBeDefined();
  h.blobs.objects.set(key, {
    bytes: new Uint8Array(5_000_001),
    contentType: "image/png",
  });
  await expect(
    h.service.download(principals.owner, input)
  ).rejects.toMatchObject({ code: "export_asset_limit" });
});

test("format, checkpoint/output limits, PDF unavailability and invalid PDF are structured refusals", async () => {
  const h = await exportHarness();
  const input = { artifactId: h.artifactId, format: "pdf" as const };
  await expect(
    h.service.download(principals.owner, { ...input, format: "pptx" })
  ).rejects.toMatchObject({ code: "export_format" });
  await expect(
    h.service.download(principals.owner, input)
  ).rejects.toMatchObject({ code: "export_unavailable" });
  const invalid = createLiveExportsService({
    ...h.deps,
    printPDF: async () => new Uint8Array([1]),
  });
  await expect(invalid.download(principals.owner, input)).rejects.toMatchObject(
    { code: "export_pdf_invalid" }
  );
  const huge = createLiveExportsService({
    ...h.deps,
    printPDF: async () => {
      const bytes = new Uint8Array(exportLimits.output + 1);
      bytes.set(new TextEncoder().encode("%PDF-"));
      return bytes;
    },
  });
  await expect(huge.download(principals.owner, input)).rejects.toMatchObject({
    code: "export_output_limit",
  });
  const snapshot = createLiveExportsService({
    ...h.deps,
    rooms: {
      snapshot: async () => ({
        revision: 0,
        state: new Uint8Array(16_000_001),
      }),
    },
  });
  await expect(
    snapshot.download(principals.owner, input)
  ).rejects.toMatchObject({ code: "export_byte_limit" });
});

test("asset reads recheck access after retrieval and cannot read another workspace's file", async () => {
  const h = await exportHarness();
  const input = { artifactId: h.artifactId, format: "docx" as const };
  const revoked = createLiveExportsService({
    ...h.deps,
    files: {
      ...h.deps.files,
      download: async (principal, id) => {
        const downloaded = await h.deps.files.download(principal, id);
        h.db
          .update(artifacts)
          .set({ deletedAt: new Date().toISOString() })
          .run();
        return downloaded;
      },
    },
  });
  await expect(revoked.download(principals.owner, input)).rejects.toBeDefined();
  h.db.update(artifacts).set({ deletedAt: null }).run();
  h.db
    .update(fileRows)
    .set({ workspaceId: "w2" })
    .where(eq(fileRows.id, "image"))
    .run();
  await expect(
    h.service.download(principals.owner, input)
  ).rejects.toBeDefined();
});

test("request cancellation stops a stalled export and observes subsequent permission/credential failure", async () => {
  const h = await exportHarness();
  const controller = new AbortController();
  const service = createLiveExportsService({
    ...h.deps,
    rooms: {
      snapshot: async () => {
        controller.abort();
        return { revision: 17, state: h.state };
      },
    },
  });
  await expect(
    service.download(
      principals.owner,
      { artifactId: h.artifactId, format: "pdf" },
      async () => undefined,
      controller.signal
    )
  ).rejects.toMatchObject({ code: "export_cancelled" });
  let checks = 0;
  await expect(
    h.service.download(
      principals.owner,
      { artifactId: h.artifactId, format: "docx" },
      async () => {
        checks += 1;
        if (checks > 3) {
          throw new ExportError("export_access_ended");
        }
      }
    )
  ).rejects.toMatchObject({ code: "export_access_ended" });
});

test("deadline bounds stalled snapshot capture without starting asset or browser work", async () => {
  const h = await exportHarness();
  const stalled = createLiveExportsService({
    ...h.deps,
    rooms: { snapshot: () => new Promise(() => undefined) },
    timeoutMs: 10,
  });
  await expect(
    stalled.download(principals.owner, {
      artifactId: h.artifactId,
      format: "pdf",
    })
  ).rejects.toMatchObject({ code: "export_timeout" });
  expect(h.counts().reads).toBe(0);
});

test("ownership removed while printing refuses delivery and request cleanup is registered", async () => {
  const h = await exportHarness();
  const pending: Promise<void>[] = [];
  const service = createLiveExportsService({
    ...h.deps,
    defer: (work) => {
      pending.push(work);
    },
    printPDF: async () => {
      h.urls.clear();
      return new TextEncoder().encode("%PDF-fixture");
    },
  });
  await expect(
    service.download(principals.owner, {
      artifactId: h.artifactId,
      format: "pdf",
    })
  ).rejects.toMatchObject({ code: "export_asset_scope" });
  await Promise.all(pending);
  expect(pending.length).toBe(1);
});
