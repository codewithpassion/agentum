import { describe, expect, test } from "bun:test";
import {
  artifacts,
  artifactVersionFiles,
  artifactVersions,
} from "@repo/db/schema/artifacts";
import { events } from "@repo/db/schema/events";
import {
  ARTIFACT_FILE_MAX_BYTES,
  ARTIFACT_WORKSPACE_MAX_BYTES,
} from "@repo/db/shared";
import { artifactManifestSchema } from "@repo/protocol/artifacts";
import { asc, eq } from "drizzle-orm";
import { unzipSync } from "fflate";
import { isForbiddenError } from "../authz.ts";
import { isServiceError } from "../errors.ts";
import {
  bytes,
  type Harness,
  harness,
  page,
  principals,
} from "./test-harness.ts";

const NOW = "2026-10-27T00:00:00.000Z";
const BLOB_PREFIX = "w1/artifact-blobs/";
const MB = 1024 * 1024;

const sha256 = async (data: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const blobKeys = (h: Harness) =>
  [...h.blobs.objects.keys()].filter((key) => key.startsWith(BLOB_PREFIX));

const eventRows = (h: Harness) =>
  h.db.select().from(events).orderBy(asc(events.id)).all();

const eventTypes = (h: Harness) => eventRows(h).map((row) => row.type);

/** Counts what a refused write must leave untouched. */
const snapshot = (h: Harness) => ({
  artifacts: h.db.select().from(artifacts).all().length,
  events: eventRows(h).length,
  files: h.db.select().from(artifactVersionFiles).all().length,
  objects: h.blobs.objects.size,
  versions: h.db.select().from(artifactVersions).all().length,
});

const errorOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
};

const expectServiceError = async (
  run: () => Promise<unknown>,
  code: string
) => {
  const error = await errorOf(run);
  if (!isServiceError(error) || error.code !== code) {
    throw new Error(`expected a ServiceError ${code}, got ${String(error)}`, {
      cause: error,
    });
  }
  return error;
};

const expectForbidden = async (run: () => Promise<unknown>) => {
  const error = await errorOf(run);
  if (!isForbiddenError(error)) {
    throw new Error(`expected ForbiddenError, got ${String(error)}`, {
      cause: error,
    });
  }
};

/** The create must be refused with `invalid` and leave no trace. */
const expectInvalidCreate = async (
  input: Parameters<Harness["service"]["create"]>[1]
) => {
  const h = harness();
  const before = snapshot(h);
  await expectServiceError(
    () => h.service.create(principals.owner, input),
    "invalid"
  );
  if (JSON.stringify(snapshot(h)) !== JSON.stringify(before)) {
    throw new Error("a refused create wrote something");
  }
};

const createPage = (h: Harness, body = "<h1>Hello</h1>") =>
  h.service.create(principals.owner, {
    files: page(body),
    kind: "page",
    title: "Report",
  });

describe("create", () => {
  test("a person creates a private artifact outside a session", async () => {
    const h = harness();
    const result = await createPage(h);
    expect(result.version).toBe(1);
    const [row] = h.db.select().from(artifacts).all();
    expect(row?.audience).toBe("private");
    expect(row?.ownerUserId).toBe("u1");
    expect(eventTypes(h)).toEqual(["artifact.created", "artifact.published"]);
    const read = await h.service.readFile(principals.owner, {
      artifactId: result.artifactId,
    });
    expect(read.text).toBe("<h1>Hello</h1>");
  });

  test("stores blobs by hash and a manifest that parses", async () => {
    const h = harness();
    const result = await h.service.create(principals.owner, {
      files: [
        { path: "index.html", text: "<p>same</p>" },
        { path: "copy.html", text: "<p>same</p>" },
        { path: "other.txt", text: "other" },
      ],
      kind: "page",
      title: "Report",
    });
    const same = await sha256(bytes("<p>same</p>"));
    const other = await sha256(bytes("other"));
    expect(blobKeys(h).sort()).toEqual(
      [`${BLOB_PREFIX}${same}`, `${BLOB_PREFIX}${other}`].sort()
    );
    expect(h.blobs.objects.get(`${BLOB_PREFIX}${same}`)?.bytes).toEqual(
      bytes("<p>same</p>")
    );
    const manifestObject = h.blobs.objects.get(
      `w1/artifact-manifests/${result.versionId}.json`
    );
    const manifest = artifactManifestSchema.parse(
      JSON.parse(new TextDecoder().decode(manifestObject?.bytes))
    );
    expect(manifest.entry).toBe("index.html");
    expect(manifest.files["copy.html"]?.sha256).toBe(same);
    expect(manifest.files["other.txt"]).toEqual({
      contentType: expect.any(String),
      sha256: other,
      size: 5,
    });
  });

  test("identical bytes in two artifacts store one blob", async () => {
    const h = harness();
    await createPage(h, "same bytes");
    await createPage(h, "same bytes");
    expect(blobKeys(h)).toHaveLength(1);
    expect(h.db.select().from(artifacts).all()).toHaveLength(2);
  });

  test("a valid base64 file stores the decoded bytes", async () => {
    const h = harness();
    const raw = new Uint8Array([0, 1, 2, 250, 255]);
    await h.service.create(principals.owner, {
      files: [
        { path: "index.html", text: "<img src=x.bin>" },
        { base64: btoa(String.fromCharCode(...raw)), path: "x.bin" },
      ],
      kind: "page",
      title: "Bin",
    });
    expect(
      h.blobs.objects.get(`${BLOB_PREFIX}${await sha256(raw)}`)?.bytes
    ).toEqual(raw);
  });

  test("a doc defaults its entry to index.md", async () => {
    const h = harness();
    const result = await h.service.create(principals.owner, {
      files: [{ path: "index.md", text: "# Doc" }],
      kind: "doc",
      title: "Doc",
    });
    const [version] = h.db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.id, result.versionId))
      .all();
    expect(version?.entry).toBe("index.md");
    await expectInvalidCreate({
      files: [{ path: "index.html", text: "x" }],
      kind: "doc",
      title: "Doc",
    });
  });

  test("a page with an explicit entry uses it", async () => {
    const h = harness();
    const result = await h.service.create(principals.owner, {
      entry: "main.html",
      files: [{ path: "main.html", text: "x" }],
      kind: "page",
      title: "Main",
    });
    const [version] = h.db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.id, result.versionId))
      .all();
    expect(version?.entry).toBe("main.html");
  });
});

describe("R1.4 limits and validation", () => {
  test("201 files are refused", async () => {
    const files = Array.from({ length: 201 }, (_, index) => ({
      path: index === 0 ? "index.html" : `f${index}.txt`,
      text: "x",
    }));
    await expectInvalidCreate({ files, kind: "page", title: "Big" });
  });

  test("200 files are accepted", async () => {
    const h = harness();
    const files = Array.from({ length: 200 }, (_, index) => ({
      path: index === 0 ? "index.html" : `f${index}.txt`,
      text: `n${index}`,
    }));
    const result = await h.service.create(principals.owner, {
      files,
      kind: "page",
      title: "Big",
    });
    expect(result.files).toBe(200);
  });

  test("a file over 10 MB is refused, exactly 10 MB is accepted", async () => {
    await expectInvalidCreate({
      files: [
        { path: "index.html", text: "a".repeat(ARTIFACT_FILE_MAX_BYTES + 1) },
      ],
      kind: "page",
      title: "Big",
    });
    const h = harness();
    const result = await h.service.create(principals.owner, {
      files: [
        { path: "index.html", text: "a".repeat(ARTIFACT_FILE_MAX_BYTES) },
      ],
      kind: "page",
      title: "Edge",
    });
    expect(result.bytes).toBe(ARTIFACT_FILE_MAX_BYTES);
  });

  test("a total over 16 MB is refused", async () => {
    const size = 10 * MB - 1024;
    await expectInvalidCreate({
      files: [
        { path: "index.html", text: "a".repeat(size) },
        { path: "b.txt", text: "b".repeat(size) },
      ],
      kind: "page",
      title: "Big",
    });
  });

  test("a missing entry is refused", async () => {
    await expectInvalidCreate({
      files: [{ path: "other.html", text: "x" }],
      kind: "page",
      title: "T",
    });
  });

  test("an entry that is not html, htm or md is refused", async () => {
    for (const entry of ["logo.svg", "data.xml", "app.js"]) {
      // biome-ignore lint/performance/noAwaitInLoops: each refusal builds its own harness
      await expectInvalidCreate({
        entry,
        files: [{ path: entry, text: "x" }],
        kind: "page",
        title: "T",
      });
    }
  });

  test("an html file with a UTF-16 byte order mark is refused, UTF-8 is not", async () => {
    for (const header of [
      [0xff, 0xfe, 0x3c, 0x00],
      [0xfe, 0xff, 0x00, 0x3c],
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each refusal builds its own harness
      await expectInvalidCreate({
        files: [
          {
            base64: Buffer.from(header).toString("base64"),
            path: "index.html",
          },
        ],
        kind: "page",
        title: "T",
      });
    }
    await expectInvalidCreate({
      files: [
        { path: "index.html", text: "<p>ok</p>" },
        {
          base64: Buffer.from([0xff, 0xfe, 0x3c, 0x00]).toString("base64"),
          path: "other.htm",
        },
      ],
      kind: "page",
      title: "T",
    });
    const h = harness();
    await h.service.create(principals.owner, {
      files: [
        {
          base64: Buffer.from([0xef, 0xbb, 0xbf, 0x3c]).toString("base64"),
          path: "index.html",
        },
      ],
      kind: "page",
      title: "T",
    });
  });

  test("duplicate paths are refused", async () => {
    await expectInvalidCreate({
      files: [
        { path: "index.html", text: "x" },
        { path: "index.html", text: "y" },
      ],
      kind: "page",
      title: "T",
    });
  });

  for (const path of ["../x.html", "a/../x.html", "/abs.html", "_hm/x"]) {
    test(`the path ${path} is refused`, async () => {
      await expectInvalidCreate({
        files: [
          { path: "index.html", text: "x" },
          { path, text: "y" },
        ],
        kind: "page",
        title: "T",
      });
    });
  }

  test("text and base64 together, or neither, are refused", async () => {
    await expectInvalidCreate({
      files: [{ base64: "eA==", path: "index.html", text: "x" }],
      kind: "page",
      title: "T",
    });
    await expectInvalidCreate({
      files: [{ path: "index.html" }],
      kind: "page",
      title: "T",
    });
  });

  test("invalid base64 is refused", async () => {
    await expectInvalidCreate({
      files: [{ base64: "!!not base64!!", path: "index.html" }],
      kind: "page",
      title: "T",
    });
  });

  test("files together with fromLibraryPath, or neither, are refused", async () => {
    await expectInvalidCreate({
      files: page(),
      fromLibraryPath: "shared/deck",
      kind: "page",
      title: "T",
    });
    await expectInvalidCreate({ kind: "page", title: "T" });
  });

  test("title, description and message lengths are checked", async () => {
    const h = harness();
    const create = (extra: {
      description?: string;
      message?: string;
      title: string;
    }) =>
      h.service.create(principals.owner, {
        files: page(),
        kind: "page",
        ...extra,
      });
    await expectServiceError(() => create({ title: "" }), "invalid");
    await expectServiceError(
      () => create({ title: "t".repeat(121) }),
      "invalid"
    );
    await expectServiceError(
      () => create({ description: "d".repeat(501), title: "T" }),
      "invalid"
    );
    await expectServiceError(
      () => create({ message: "m".repeat(501), title: "T" }),
      "invalid"
    );
    expect(h.db.select().from(artifacts).all()).toHaveLength(0);
    await create({ title: "t".repeat(120) });
    await create({
      description: "d".repeat(500),
      message: "m".repeat(500),
      title: "T",
    });
    expect(h.db.select().from(artifacts).all()).toHaveLength(2);
  });

  test("update checks the title and message lengths", async () => {
    const h = harness();
    const { artifactId } = await createPage(h);
    const before = snapshot(h);
    await expectServiceError(
      () =>
        h.service.update(principals.owner, {
          artifactId,
          baseVersion: 1,
          files: page("v2"),
          title: "",
        }),
      "invalid"
    );
    await expectServiceError(
      () =>
        h.service.update(principals.owner, {
          artifactId,
          baseVersion: 1,
          files: page("v2"),
          message: "m".repeat(501),
        }),
      "invalid"
    );
    expect(snapshot(h)).toEqual(before);
  });
});

describe("R1.3 racing updates", () => {
  test("two updates on the same base: one wins, the other conflicts", async () => {
    const h = harness();
    const { artifactId } = await h.service.create(principals.owner, {
      files: page(),
      kind: "page",
      title: "Race",
    });
    const attempt = (body: string) =>
      h.service.update(principals.owner, {
        artifactId,
        baseVersion: 1,
        files: page(body),
      });
    const results = await Promise.allSettled([attempt("a"), attempt("b")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toMatchObject({
      code: "conflict",
    });
    const versions = await h.service.versions(principals.owner, artifactId);
    expect(versions.map((v) => v.number)).toEqual([2, 1]);
  });
});

describe("R1.5 default audience and owner", () => {
  const audienceOf = async (principal: typeof principals.agentOne) => {
    const h = harness();
    const { artifactId } = await h.service.create(principal, {
      files: page(),
      kind: "page",
      title: "T",
    });
    const [row] = h.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, artifactId))
      .all();
    return row;
  };

  test("a ui session publishes private", async () => {
    const row = await audienceOf(principals.agentOneInUi);
    expect(row?.audience).toBe("private");
    expect(row?.ownerUserId).toBe("u1");
    expect(row?.sessionId).toBe("s-ui");
  });

  test("a private session publishes private", async () => {
    const row = await audienceOf({
      ...principals.agentOne,
      runId: "r-private",
    });
    expect(row?.audience).toBe("private");
    expect(row?.sessionId).toBe("s-private");
  });

  test("a shared session publishes to the workspace", async () => {
    const row = await audienceOf(principals.agentOne);
    expect(row?.audience).toBe("workspace");
    expect(row?.ownerUserId).toBe("u1");
    expect(row?.agentId).toBe("a1");
    expect(row?.runId).toBe("r-shared");
    expect(row?.sessionId).toBe("s-shared");
  });

  test("a run with no person behind it has no owner", async () => {
    const row = await audienceOf(principals.agentTwo);
    expect(row?.ownerUserId).toBeNull();
    expect(row?.audience).toBe("workspace");
  });
});

describe("update and R1.3 conflicts", () => {
  test("update adds a version with the new tree and parentNumber", async () => {
    const h = harness();
    const { artifactId } = await createPage(h, "v1");
    const result = await h.service.update(principals.owner, {
      artifactId,
      baseVersion: 1,
      files: page("v2"),
      message: "second",
      title: "Renamed",
    });
    expect(result.version).toBe(2);
    const rows = h.db
      .select()
      .from(artifactVersions)
      .orderBy(asc(artifactVersions.number))
      .all();
    expect(rows.map((r) => [r.number, r.parentNumber])).toEqual([
      [1, null],
      [2, 1],
    ]);
    expect(rows[1]?.message).toBe("second");
    const [row] = h.db.select().from(artifacts).all();
    expect(row?.title).toBe("Renamed");
    expect(row?.currentVersionId).toBe(result.versionId);
    expect(
      (await h.service.readFile(principals.owner, { artifactId })).text
    ).toBe("v2");
    expect(
      (await h.service.readFile(principals.owner, { artifactId, version: 1 }))
        .text
    ).toBe("v1");
    expect(eventTypes(h)).toEqual([
      "artifact.created",
      "artifact.published",
      "artifact.published",
    ]);
  });

  test("a stale baseVersion conflicts and writes nothing", async () => {
    const h = harness();
    const { artifactId } = await createPage(h, "v1");
    await h.service.update(principals.owner, {
      artifactId,
      baseVersion: 1,
      files: page("v2"),
    });
    const before = snapshot(h);
    const error = await expectServiceError(
      () =>
        h.service.update(principals.owner, {
          artifactId,
          baseVersion: 1,
          files: page("brand new bytes"),
        }),
      "conflict"
    );
    expect(error.message).toContain("2");
    expect(snapshot(h)).toEqual(before);
    expect(blobKeys(h)).toHaveLength(2);
  });

  test("a refused update leaves nothing behind", async () => {
    const h = harness();
    const { artifactId } = await createPage(h);
    const before = snapshot(h);
    await expectServiceError(
      () =>
        h.service.update(principals.owner, {
          artifactId,
          baseVersion: 1,
          files: [{ path: "other.html", text: "x" }],
        }),
      "invalid"
    );
    expect(snapshot(h)).toEqual(before);
  });
});

describe("R1.2 restore", () => {
  test("restore creates max+1 with the old tree and history only grows", async () => {
    const h = harness();
    const { artifactId } = await h.service.create(principals.owner, {
      files: [
        { path: "index.html", text: "v1" },
        { path: "a.txt", text: "only in v1" },
      ],
      kind: "page",
      title: "T",
    });
    await h.service.update(principals.owner, {
      artifactId,
      baseVersion: 1,
      files: page("v2"),
    });
    await h.service.update(principals.owner, {
      artifactId,
      baseVersion: 2,
      files: page("v3"),
    });
    const blobsBefore = blobKeys(h).length;
    const restored = await h.service.restore(principals.owner, artifactId, 1);
    expect(restored.version).toBe(4);

    const rows = h.db
      .select()
      .from(artifactVersions)
      .orderBy(asc(artifactVersions.number))
      .all();
    expect(rows.map((r) => r.number)).toEqual([1, 2, 3, 4]);
    expect(rows[3]?.parentNumber).toBe(3);
    const filesOf = (versionId: string) =>
      h.db
        .select()
        .from(artifactVersionFiles)
        .where(eq(artifactVersionFiles.versionId, versionId))
        .orderBy(asc(artifactVersionFiles.path))
        .all()
        .map((file) => [file.path, file.sha256, file.size]);
    expect(filesOf(rows[3]?.id ?? "")).toEqual(filesOf(rows[0]?.id ?? ""));
    expect(filesOf(rows[3]?.id ?? "")).toHaveLength(2);
    expect(blobKeys(h)).toHaveLength(blobsBefore);

    const [row] = h.db.select().from(artifacts).all();
    expect(row?.currentVersionId).toBe(rows[3]?.id);
    expect(
      (await h.service.readFile(principals.owner, { artifactId })).text
    ).toBe("v1");
    expect(eventTypes(h).slice(-2)).toEqual([
      "artifact.restored",
      "artifact.published",
    ]);
  });

  test("restoring a version that does not exist is not_found and writes nothing", async () => {
    const h = harness();
    const { artifactId } = await createPage(h);
    const before = snapshot(h);
    await expectServiceError(
      () => h.service.restore(principals.owner, artifactId, 9),
      "not_found"
    );
    expect(snapshot(h)).toEqual(before);
  });

  test("a run cannot restore", async () => {
    const h = harness();
    const { artifactId } = await h.service.create(principals.agentOne, {
      files: page(),
      kind: "page",
      title: "T",
    });
    await expectForbidden(() =>
      h.service.restore(principals.agentOne, artifactId, 1)
    );
  });
});

describe("R1.8 fromLibraryPath", () => {
  const seedLibrary = async (h: Harness) => {
    h.grant("a1", "shared/deck", "read");
    await h.library.write(
      principals.owner,
      "shared/deck/index.html",
      bytes("<h1>deck</h1>")
    );
    await h.library.write(
      principals.owner,
      "shared/deck/css/a.css",
      bytes("body{}")
    );
    await h.library.write(
      principals.owner,
      "shared/secret/index.html",
      bytes("secret")
    );
  };

  test("an agent publishes a granted folder with relative paths", async () => {
    const h = harness();
    await seedLibrary(h);
    const result = await h.service.create(principals.agentOne, {
      fromLibraryPath: "shared/deck",
      kind: "page",
      title: "Deck",
    });
    expect(result.files).toBe(2);
    const files = h.db
      .select()
      .from(artifactVersionFiles)
      .where(eq(artifactVersionFiles.versionId, result.versionId))
      .all()
      .map((file) => file.path)
      .sort();
    expect(files).toEqual(["css/a.css", "index.html"]);
    const [version] = h.db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.id, result.versionId))
      .all();
    expect(version?.sourceLibraryPath).toBe("shared/deck");
    expect(
      (
        await h.service.readFile(principals.agentOne, {
          artifactId: result.artifactId,
        })
      ).text
    ).toBe("<h1>deck</h1>");
  });

  test("a folder outside the run's scope is not_found and writes nothing", async () => {
    const h = harness();
    await seedLibrary(h);
    const before = snapshot(h);
    await expectServiceError(
      () =>
        h.service.create(principals.agentOne, {
          fromLibraryPath: "shared/secret",
          kind: "page",
          title: "Secret",
        }),
      "not_found"
    );
    expect(snapshot(h)).toEqual(before);
  });

  test("a person can publish any folder", async () => {
    const h = harness();
    await seedLibrary(h);
    const result = await h.service.create(principals.owner, {
      fromLibraryPath: "shared/secret",
      kind: "page",
      title: "Secret",
    });
    expect(result.files).toBe(1);
  });
});

describe("R1.9 who may write", () => {
  const sharedArtifact = async (h: Harness) =>
    (
      await h.service.create(principals.agentOne, {
        files: page("v1"),
        kind: "page",
        title: "Mine",
      })
    ).artifactId;

  test("an agent updates its own artifact", async () => {
    const h = harness();
    const artifactId = await sharedArtifact(h);
    const result = await h.service.update(principals.agentOne, {
      artifactId,
      baseVersion: 1,
      files: page("v2"),
    });
    expect(result.version).toBe(2);
  });

  test("another agent is forbidden on a workspace artifact", async () => {
    const h = harness();
    const artifactId = await sharedArtifact(h);
    const before = snapshot(h);
    await expectForbidden(() =>
      h.service.update(principals.agentTwo, {
        artifactId,
        baseVersion: 1,
        files: page("v2"),
      })
    );
    expect(snapshot(h)).toEqual(before);
  });

  test("another agent gets not_found on a private artifact", async () => {
    const h = harness();
    const { artifactId } = await h.service.create(principals.agentOneInUi, {
      files: page("v1"),
      kind: "page",
      title: "Private",
    });
    await expectServiceError(
      () =>
        h.service.update(principals.agentTwo, {
          artifactId,
          baseVersion: 1,
          files: page("v2"),
        }),
      "not_found"
    );
  });

  test("a dry run and a read-only key cannot create", async () => {
    const h = harness();
    const input = { files: page(), kind: "page" as const, title: "T" };
    await expectForbidden(() =>
      h.service.create({ ...principals.agentOne, dryRun: true }, input)
    );
    await expectForbidden(() => h.service.create(principals.keyReader, input));
    expect(snapshot(h).artifacts).toBe(0);
  });

  test("a person who is not owner or admin cannot update, an admin can", async () => {
    const h = harness();
    const artifactId = await sharedArtifact(h);
    await expectForbidden(() =>
      h.service.update(principals.stranger, {
        artifactId,
        baseVersion: 1,
        files: page("v2"),
      })
    );
    const result = await h.service.update(principals.admin, {
      artifactId,
      baseVersion: 1,
      files: page("v2"),
    });
    expect(result.version).toBe(2);
  });

  test("a person from another workspace cannot see the artifact", async () => {
    const h = harness();
    const artifactId = await sharedArtifact(h);
    await expectServiceError(
      () =>
        h.service.update(principals.otherWorkspace, {
          artifactId,
          baseVersion: 1,
          files: page("v2"),
        }),
      "not_found"
    );
  });
});

describe("workspace quota", () => {
  /** Seeds an old artifact whose files take `filler` bytes of fake blobs plus one known blob. */
  const seedUsage = async (h: Harness, known: Uint8Array) => {
    h.db
      .insert(artifacts)
      .values({
        audience: "workspace",
        createdAt: NOW,
        createdById: "u1",
        createdByKind: "user",
        id: "seed",
        kind: "page",
        title: "Seed",
        updatedAt: NOW,
        workspaceId: "w1",
      })
      .run();
    h.db
      .insert(artifactVersions)
      .values({
        artifactId: "seed",
        authorId: "u1",
        authorKind: "user",
        createdAt: NOW,
        entry: "index.html",
        fileCount: 2,
        id: "seed-v1",
        manifestKey: "w1/artifact-manifests/seed-v1.json",
        message: "",
        number: 1,
        status: "published",
        totalBytes: ARTIFACT_WORKSPACE_MAX_BYTES,
        workspaceId: "w1",
      })
      .run();
    h.db
      .insert(artifactVersionFiles)
      .values([
        {
          contentType: "text/html",
          path: "index.html",
          sha256: "f".repeat(64),
          size: ARTIFACT_WORKSPACE_MAX_BYTES - known.byteLength,
          versionId: "seed-v1",
          workspaceId: "w1",
        },
        {
          contentType: "text/plain",
          path: "known.txt",
          sha256: await sha256(known),
          size: known.byteLength,
          versionId: "seed-v1",
          workspaceId: "w1",
        },
      ])
      .run();
  };

  test("a create that would pass the quota is refused", async () => {
    const h = harness();
    await seedUsage(h, bytes("12345"));
    const before = snapshot(h);
    await expectServiceError(() => createPage(h, "new bytes"), "invalid");
    expect(snapshot(h)).toEqual(before);
  });

  test("files whose hashes are already known are not counted again", async () => {
    const h = harness();
    await seedUsage(h, bytes("12345"));
    const result = await createPage(h, "12345");
    expect(result.version).toBe(1);
    expect(blobKeys(h)).toHaveLength(0);
  });
});

describe("events", () => {
  test("create writes created then published with the run's scope", async () => {
    const h = harness();
    const result = await h.service.create(principals.agentOne, {
      files: page(),
      kind: "page",
      title: "Report",
      toolCallId: "tc1",
    });
    const rows = eventRows(h);
    expect(rows.map((row) => row.type)).toEqual([
      "artifact.created",
      "artifact.published",
    ]);
    for (const row of rows) {
      expect(row.sessionId).toBe("s-shared");
      expect(row.runId).toBe("r-shared");
      expect(row.agentId).toBe("a1");
      expect(row.actorKind).toBe("agent");
      expect(row.actorId).toBe("a1");
    }
    expect(JSON.parse(rows[1]?.payload ?? "null")).toEqual({
      artifactId: result.artifactId,
      kind: "page",
      runId: "r-shared",
      sessionId: "s-shared",
      title: "Report",
      toolCallId: "tc1",
      version: 1,
      versionId: result.versionId,
    });
  });

  test("a person's published event has null run and session and no toolCallId", async () => {
    const h = harness();
    const result = await createPage(h);
    const [, published] = eventRows(h);
    expect(published?.actorKind).toBe("user");
    expect(published?.runId).toBeNull();
    expect(JSON.parse(published?.payload ?? "null")).toEqual({
      artifactId: result.artifactId,
      kind: "page",
      runId: null,
      sessionId: null,
      title: "Report",
      version: 1,
      versionId: result.versionId,
    });
  });

  test("no event payload or blob key holds a token prefix", async () => {
    const h = harness();
    const { artifactId } = await createPage(h);
    await h.service.update(principals.owner, {
      artifactId,
      baseVersion: 1,
      files: page("v2"),
    });
    await h.service.restore(principals.owner, artifactId, 1);
    const haystack = [
      ...eventRows(h).map((row) => row.payload ?? ""),
      ...h.blobs.objects.keys(),
    ].join("\n");
    expect(haystack).not.toContain("hm_view_");
    expect(haystack).not.toContain("hm_share_");
  });
});

describe("versions files, thumbnails and download", () => {
  const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const FILES = [
    { path: "index.html", text: "<h1>One</h1>" },
    { path: "css/site.css", text: "h1{}" },
  ];

  const make = async (h: Harness) =>
    await h.service.create(principals.agentOne, {
      files: FILES,
      kind: "page",
      title: "Q3 Report!",
    });

  test("versions fill the files of every version", async () => {
    const h = harness();
    const made = await make(h);
    await h.service.update(principals.agentOne, {
      artifactId: made.artifactId,
      baseVersion: 1,
      files: [{ path: "index.html", text: "<h1>Two</h1>" }],
    });
    const list = await h.service.versions(principals.owner, made.artifactId);
    expect(list.map((version) => version.number)).toEqual([2, 1]);
    expect(list[0]?.files).toEqual([
      { contentType: "text/html; charset=utf-8", path: "index.html", size: 12 },
    ]);
    expect(list[1]?.files?.map((file) => file.path)).toEqual([
      "css/site.css",
      "index.html",
    ]);
  });

  test("setThumbnail then thumbnail round trip", async () => {
    const h = harness();
    const made = await make(h);
    await expectServiceError(
      () => h.service.thumbnail(principals.agentOne, made.artifactId),
      "not_found"
    );
    await h.service.setThumbnail(principals.agentOne, {
      artifactId: made.artifactId,
      png: PNG,
      versionId: made.versionId,
    });
    expect(
      await h.service.thumbnail(principals.agentOne, made.artifactId)
    ).toEqual(PNG);
    expect(
      await h.service.thumbnail(principals.agentOne, made.artifactId, 1)
    ).toEqual(PNG);
    expect(
      h.blobs.objects.has(`w1/artifact-thumbnails/${made.versionId}.png`)
    ).toBe(true);
    const [version] = await h.service.versions(
      principals.agentOne,
      made.artifactId
    );
    expect(version?.hasThumbnail).toBe(true);
    const card = await h.service.get(principals.agentOne, made.artifactId);
    expect(card.hasThumbnail).toBe(true);
    expect(eventTypes(h)).toEqual(["artifact.created", "artifact.published"]);
  });

  test("a thumbnail of an old version leaves the card alone", async () => {
    const h = harness();
    const made = await make(h);
    await h.service.update(principals.agentOne, {
      artifactId: made.artifactId,
      baseVersion: 1,
      files: FILES,
    });
    await h.service.setThumbnail(principals.agentOne, {
      artifactId: made.artifactId,
      png: PNG,
      versionId: made.versionId,
    });
    const card = await h.service.get(principals.agentOne, made.artifactId);
    expect(card.hasThumbnail).toBe(false);
    expect(
      await h.service.thumbnail(principals.agentOne, made.artifactId, 1)
    ).toEqual(PNG);
  });

  test("a new version clears the card's thumbnail so the two agree", async () => {
    const h = harness();
    const made = await make(h);
    await h.service.setThumbnail(principals.agentOne, {
      artifactId: made.artifactId,
      png: PNG,
      versionId: made.versionId,
    });
    const updated = await h.service.update(principals.agentOne, {
      artifactId: made.artifactId,
      baseVersion: 1,
      files: FILES,
    });
    expect(
      (await h.service.get(principals.agentOne, made.artifactId)).hasThumbnail
    ).toBe(false);
    await expectServiceError(
      () => h.service.thumbnail(principals.agentOne, made.artifactId),
      "not_found"
    );
    await h.service.setThumbnail(principals.agentOne, {
      artifactId: made.artifactId,
      png: PNG,
      versionId: updated.versionId,
    });
    await h.service.restore(principals.owner, made.artifactId, 1);
    expect(
      (await h.service.get(principals.agentOne, made.artifactId)).hasThumbnail
    ).toBe(false);
  });

  test("setThumbnail is refused for a person and for a foreign version", async () => {
    const h = harness();
    const made = await make(h);
    const other = await h.service.create(principals.agentOne, {
      files: FILES,
      kind: "page",
      title: "Other",
    });
    const input = { artifactId: made.artifactId, png: PNG };
    const error = await errorOf(() =>
      h.service.setThumbnail(principals.owner, {
        ...input,
        versionId: made.versionId,
      })
    );
    expect(isForbiddenError(error)).toBe(true);
    await expectServiceError(
      () =>
        h.service.setThumbnail(principals.agentOne, {
          ...input,
          versionId: other.versionId,
        }),
      "not_found"
    );
  });

  test("download is a zip of the version files", async () => {
    const h = harness();
    const made = await make(h);
    const result = await h.service.download(principals.owner, made.artifactId);
    expect(result.filename).toBe("q3-report-v1.zip");
    const unzipped = unzipSync(result.bytes);
    expect(Object.keys(unzipped).sort()).toEqual([
      "css/site.css",
      "index.html",
    ]);
    expect(new TextDecoder().decode(unzipped["index.html"])).toBe(
      "<h1>One</h1>"
    );
    await expectServiceError(
      () => h.service.download(principals.owner, made.artifactId, 9),
      "not_found"
    );
  });

  test("a member who cannot see the artifact gets not_found", async () => {
    const h = harness();
    const made = await h.service.create(principals.owner, {
      files: FILES,
      kind: "page",
      title: "Private",
    });
    await expectServiceError(
      () => h.service.thumbnail(principals.stranger, made.artifactId),
      "not_found"
    );
    await expectServiceError(
      () => h.service.download(principals.stranger, made.artifactId),
      "not_found"
    );
    await expectServiceError(
      () => h.service.versions(principals.stranger, made.artifactId),
      "not_found"
    );
    await expectServiceError(
      () =>
        h.service.setThumbnail(principals.agentTwo, {
          artifactId: made.artifactId,
          png: PNG,
          versionId: made.versionId,
        }),
      "not_found"
    );
  });
});
