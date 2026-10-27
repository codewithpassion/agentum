import { describe, expect, test } from "bun:test";
import { agents } from "@repo/db/schema/agents";
import {
  artifacts,
  artifactVersionFiles,
  artifactVersions,
} from "@repo/db/schema/artifacts";
import { events } from "@repo/db/schema/events";
import { artifactMembers } from "@repo/db/schema/live-artifacts";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { LIVE_DOC_MAX_BYTES } from "@repo/db/shared";
import { artifactManifestSchema } from "@repo/protocol/artifacts";
import { eq } from "drizzle-orm";
import { bytes, harness, principals } from "../artifacts/test-harness.ts";
import { ForbiddenError } from "../authz.ts";
import { ServiceError } from "../errors.ts";
import {
  createLiveArtifactsService,
  type DocumentSnapshot,
  type LiveContentCodec,
  type LiveRoomScope,
  type LiveRoomsPort,
} from "./service.ts";
import { verifyRoomTicket } from "./ticket.ts";

const NOW = "2026-10-27T00:00:00.000Z";
const KEY = "test-private-room-signing-key";
const encode = (markdown: string, revision = 0): DocumentSnapshot => ({
  revision,
  state: bytes(JSON.stringify({ markdown, revision })),
});
const decode = (state: Uint8Array): { markdown: string; revision: number } =>
  JSON.parse(new TextDecoder().decode(state));

const setup = () => {
  const h = harness();
  const restores: {
    scope: LiveRoomScope;
    versionId: string;
    byParticipant: string;
    markdown: string;
  }[] = [];
  const refreshes: { scope: LiveRoomScope; participantId?: string }[] = [];
  let roomRevision = 0;
  const content: LiveContentCodec = {
    exportDocument: (snapshot) => {
      const { markdown } = decode(snapshot.state);
      return Promise.resolve({
        html: `<article>${markdown.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</article>`,
        markdown,
      });
    },
    importMarkdown: async (markdown) => encode(markdown),
    loadDocument: (state) => {
      const document = decode(state);
      return Promise.resolve(encode(document.markdown, document.revision));
    },
  };
  const rooms: LiveRoomsPort = {
    refresh: (scope, participantId) => {
      refreshes.push({ participantId, scope });
      return Promise.resolve();
    },
    restore: (scope, input) => {
      const { markdown } = decode(input.snapshot.state);
      restores.push({
        byParticipant: input.byParticipant,
        markdown,
        scope,
        versionId: input.versionId,
      });
      roomRevision += 10;
      return Promise.resolve(encode(markdown, roomRevision));
    },
    url: ({ artifactId }) => `/api/rooms/${artifactId}`,
  };
  const deps = {
    ...h,
    artifacts: h.service,
    clock: { now: () => new Date(NOW), sleep: async () => undefined },
    content,
    identity: async () => ({ color: "#123abc", name: "Server identity" }),
    rooms,
    ticketKey: KEY,
  };
  const service = createLiveArtifactsService(deps);
  const create = () =>
    service.createDocument(principals.owner, {
      markdown: "# Original",
      title: "Live report",
    });
  const grant = (
    artifactId: string,
    role: "viewer" | "commenter" | "editor",
    extra: { workspaceId?: string; expiresAt?: string; revokedAt?: string } = {}
  ) =>
    h.db
      .insert(artifactMembers)
      .values({
        artifactId,
        createdAt: NOW,
        createdBy: "u1",
        id: crypto.randomUUID(),
        principalKind: "user",
        role,
        userId: "u2",
        workspaceId: "w1",
        ...extra,
      })
      .run();
  const counts = () => [
    h.db.select().from(artifacts).all().length,
    h.db.select().from(artifactVersions).all().length,
    h.db.select().from(events).all().length,
    h.blobs.objects.size,
  ];
  return {
    ...h,
    artifacts: h.service,
    content,
    counts,
    create,
    deps,
    grant,
    refreshes,
    restores,
    service,
  };
};

const refuses = async (call: () => Promise<unknown>, code: string) => {
  try {
    await call();
  } catch (error) {
    if (
      !(error instanceof ServiceError || error instanceof ForbiddenError) ||
      error.code !== code
    ) {
      throw new Error(`Expected ${code}, got ${String(error)}`, {
        cause: error,
      });
    }
    return;
  }
  throw new Error("Expected refusal");
};

describe("live artifacts persistence", () => {
  test("creation commits document, initial checkpoint, manifest and normal readable files", async () => {
    const h = setup();
    const result = await h.create();
    const row = h.db.select().from(artifacts).get();
    expect(row).toMatchObject({
      audience: "private",
      currentVersionId: result.versionId,
      id: result.artifactId,
      kind: "document",
      liveRoomRev: 0,
      ownerUserId: "u1",
    });
    const version = h.db.select().from(artifactVersions).get();
    expect(version).toMatchObject({
      entry: "index.html",
      fileCount: 3,
      number: 1,
      parentNumber: null,
      status: "published",
    });
    const manifest = artifactManifestSchema.parse(
      JSON.parse(
        new TextDecoder().decode(
          h.blobs.objects.get(`w1/artifact-manifests/${result.versionId}.json`)
            ?.bytes
        )
      )
    );
    expect(Object.keys(manifest.files).sort()).toEqual([
      "index.html",
      "index.md",
      "state.ydoc",
    ]);
    expect(
      (
        await h.artifacts.readFile(principals.owner, {
          artifactId: result.artifactId,
          path: "index.md",
        })
      ).text
    ).toBe("# Original");
    expect(
      h.db
        .select()
        .from(events)
        .all()
        .map((event) => event.type)
    ).toEqual([
      "artifact.created",
      "artifact.live_checkpoint",
      "artifact.published",
    ]);
  });

  test("conversion reads the static doc, keeps it intact and links the new document", async () => {
    const h = setup();
    const old = await h.artifacts.create(principals.owner, {
      files: [{ path: "index.md", text: "# Convert me" }],
      kind: "doc",
      title: "Static",
    });
    const converted = await h.service.convertDoc(principals.owner, {
      artifactId: old.artifactId,
    });
    expect(
      h.db
        .select()
        .from(artifacts)
        .where(eq(artifacts.id, converted.artifactId))
        .get()
    ).toMatchObject({
      convertedFromId: old.artifactId,
      kind: "document",
      title: "Static",
    });
    expect(
      (
        await h.artifacts.readFile(principals.owner, {
          artifactId: old.artifactId,
        })
      ).text
    ).toBe("# Convert me");
    expect(
      (
        await h.artifacts.readFile(principals.owner, {
          artifactId: converted.artifactId,
          path: "index.md",
        })
      ).text
    ).toBe("# Convert me");
  });

  test("checkpoint advances revision and creates an immutable normal version; stale saves leave no writes", async () => {
    const h = setup();
    const doc = await h.create();
    const saved = await h.service.checkpoint(principals.owner, {
      artifactId: doc.artifactId,
      ...encode("Changed", 4),
    });
    expect(saved.version).toBe(2);
    expect(h.db.select().from(artifacts).get()?.liveRoomRev).toBe(4);
    expect(
      (
        await h.artifacts.readFile(principals.owner, {
          artifactId: doc.artifactId,
          path: "index.md",
          version: 1,
        })
      ).text
    ).toBe("# Original");
    expect(
      (
        await h.artifacts.readFile(principals.owner, {
          artifactId: doc.artifactId,
          path: "index.html",
        })
      ).text
    ).toBe("<article>Changed</article>");
    const before = h.counts();
    await refuses(
      () =>
        h.service.checkpoint(principals.owner, {
          artifactId: doc.artifactId,
          ...encode("stale", 4),
        }),
      "conflict"
    );
    expect(h.counts()).toEqual(before);
  });

  test("restore loads authorized state, calls room with actor and persists its new revision", async () => {
    const h = setup();
    const doc = await h.create();
    await h.service.checkpoint(principals.owner, {
      artifactId: doc.artifactId,
      ...encode("Changed", 2),
    });
    const restored = await h.service.restore(principals.owner, {
      artifactId: doc.artifactId,
      version: 1,
    });
    expect(restored.version).toBe(3);
    expect(h.restores).toEqual([
      {
        byParticipant: "u:u1",
        markdown: "# Original",
        scope: { artifactId: doc.artifactId, workspaceId: "w1" },
        versionId: doc.versionId,
      },
    ]);
    expect(h.db.select().from(artifacts).get()?.liveRoomRev).toBe(10);
    expect(
      (
        await h.artifacts.readFile(principals.owner, {
          artifactId: doc.artifactId,
          path: "index.md",
        })
      ).text
    ).toBe("# Original");
  });

  test("atomic failure rolls back all DB rows", async () => {
    const h = setup();
    const service = createLiveArtifactsService({
      ...h.deps,
      atomic: async (statements) =>
        h.atomic([
          ...statements,
          h.db.insert(artifactVersionFiles).values({
            contentType: "text/plain",
            path: "bad",
            sha256: "bad",
            size: 0,
            versionId: "missing",
            workspaceId: "w1",
          }),
        ]),
    });
    await expect(
      service.createDocument(principals.owner, { title: "Fail" })
    ).rejects.toThrow();
    expect(h.db.select().from(artifacts).all()).toHaveLength(0);
    expect(h.db.select().from(artifactVersions).all()).toHaveLength(0);
    expect(h.db.select().from(events).all()).toHaveLength(0);
  });

  test("racing checkpoints cannot move the current version backwards", async () => {
    const h = setup();
    const doc = await h.create();
    let unblock: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const renderer = h.content.exportDocument;
    h.content.exportDocument = async (snapshot) => {
      if (snapshot.revision === 1) {
        entered();
        await blocked;
      }
      return await renderer(snapshot);
    };
    const slow = h.service.checkpoint(principals.owner, {
      artifactId: doc.artifactId,
      ...encode("Slow", 1),
    });
    await started;
    await h.service.checkpoint(principals.owner, {
      artifactId: doc.artifactId,
      ...encode("New", 2),
    });
    unblock();
    await refuses(() => slow, "conflict");
    expect(h.db.select().from(artifacts).get()?.liveRoomRev).toBe(2);
    expect(h.db.select().from(artifactVersions).all()).toHaveLength(2);
  });
});

describe("live authorization and tickets", () => {
  test("join derives signed identity, role and bounded lifetime from server sources", async () => {
    const h = setup();
    const doc = await h.create();
    const joined = await h.service.join(principals.owner, {
      artifactId: doc.artifactId,
    });
    const claims = await verifyRoomTicket(joined.ticket, KEY, {
      artifactId: doc.artifactId,
      nowSeconds: Date.parse(NOW) / 1000,
      workspaceId: "w1",
    });
    expect(claims).toMatchObject({
      color: "#123abc",
      kind: "member",
      name: "Server identity",
      participantId: "u:u1",
      role: "owner",
    });
    expect((claims?.expiresAt ?? 0) - (claims?.issuedAt ?? 0)).toBe(120);
    expect((claims?.connectionExpiresAt ?? 0) - (claims?.issuedAt ?? 0)).toBe(
      900
    );
    const second = await h.service.join(principals.owner, {
      artifactId: doc.artifactId,
    });
    expect(second.ticket).not.toBe(joined.ticket);
  });

  test("private, admin and workspace access are checked from current DB audience", async () => {
    const h = setup();
    const doc = await h.create();
    await refuses(
      () => h.service.join(principals.stranger, { artifactId: doc.artifactId }),
      "not_found"
    );
    expect(
      (await h.service.join(principals.admin, { artifactId: doc.artifactId }))
        .role
    ).toBe("owner");
    await h.service.setAudience(principals.owner, {
      artifactId: doc.artifactId,
      audience: "workspace",
    });
    expect(
      (
        await h.service.join(principals.stranger, {
          artifactId: doc.artifactId,
        })
      ).role
    ).toBe("editor");
    await h.service.setAudience(principals.owner, {
      artifactId: doc.artifactId,
      audience: "private",
    });
    await refuses(
      () => h.service.join(principals.stranger, { artifactId: doc.artifactId }),
      "not_found"
    );
    expect(h.refreshes).toHaveLength(2);
  });

  test("named roles, expiry and revocation are reread, and cannot grant owner powers", async () => {
    const h = setup();
    const doc = await h.create();
    h.grant(doc.artifactId, "viewer");
    expect(
      (
        await h.service.join(principals.stranger, {
          artifactId: doc.artifactId,
        })
      ).role
    ).toBe("viewer");
    await refuses(
      () =>
        h.service.checkpoint(principals.stranger, {
          artifactId: doc.artifactId,
          ...encode("Denied", 1),
        }),
      "forbidden"
    );
    h.db.update(artifactMembers).set({ role: "commenter" }).run();
    expect(
      (
        await h.service.join(principals.stranger, {
          artifactId: doc.artifactId,
        })
      ).role
    ).toBe("commenter");
    h.db.update(artifactMembers).set({ role: "editor" }).run();
    await h.service.checkpoint(principals.stranger, {
      artifactId: doc.artifactId,
      ...encode("Allowed", 1),
    });
    await refuses(
      () =>
        h.service.restore(principals.stranger, {
          artifactId: doc.artifactId,
          version: 1,
        }),
      "forbidden"
    );
    h.db.update(artifactMembers).set({ expiresAt: NOW }).run();
    await refuses(
      () => h.service.join(principals.stranger, { artifactId: doc.artifactId }),
      "not_found"
    );
    h.db.update(artifactMembers).set({ expiresAt: null, revokedAt: NOW }).run();
    await refuses(
      () => h.service.join(principals.stranger, { artifactId: doc.artifactId }),
      "not_found"
    );
  });

  test("read-only credentials receive viewer tickets and cannot create, convert or restore", async () => {
    const h = setup();
    const doc = await h.create();
    expect(
      (
        await h.service.join(principals.keyReader, {
          artifactId: doc.artifactId,
        })
      ).role
    ).toBe("viewer");
    const before = h.counts();
    await refuses(
      () => h.service.createDocument(principals.keyReader, { title: "Denied" }),
      "forbidden"
    );
    await refuses(
      () =>
        h.service.restore(principals.keyReader, {
          artifactId: doc.artifactId,
          version: 1,
        }),
      "forbidden"
    );
    expect(h.counts()).toEqual(before);
  });

  test("cross-workspace artifacts, conversions and grants cannot be followed", async () => {
    const h = setup();
    const doc = await h.create();
    const old = await h.artifacts.create(principals.owner, {
      files: [{ path: "index.md", text: "Secret" }],
      kind: "doc",
      title: "Static",
    });
    const before = h.counts();
    await refuses(
      () =>
        h.service.convertDoc(principals.otherWorkspace, {
          artifactId: old.artifactId,
        }),
      "not_found"
    );
    await refuses(
      () =>
        h.service.join(principals.otherWorkspace, {
          artifactId: doc.artifactId,
        }),
      "not_found"
    );
    await refuses(
      () =>
        h.service.restore(principals.otherWorkspace, {
          artifactId: doc.artifactId,
          version: 1,
        }),
      "not_found"
    );
    await refuses(
      () =>
        h.service.checkpoint(principals.otherWorkspace, {
          artifactId: doc.artifactId,
          ...encode("Denied", 1),
        }),
      "not_found"
    );
    h.grant(doc.artifactId, "editor", { workspaceId: "w2" });
    await refuses(
      () => h.service.join(principals.stranger, { artifactId: doc.artifactId }),
      "not_found"
    );
    expect(h.counts()).toEqual(before);
    expect(h.restores).toHaveLength(0);
  });

  test("run creation validates agent and session parents in the same workspace", async () => {
    const h = setup();
    const doc = await h.service.createDocument(principals.agentOne, {
      title: "Agent doc",
    });
    expect(h.db.select().from(artifacts).get()).toMatchObject({
      agentId: "a1",
      audience: "workspace",
      ownerUserId: "u1",
      runId: "r-shared",
      sessionId: "s-shared",
    });
    expect(
      (
        await h.service.join(principals.agentOne, {
          artifactId: doc.artifactId,
        })
      ).role
    ).toBe("editor");
    expect(
      (
        await h.service.join(principals.agentTwo, {
          artifactId: doc.artifactId,
        })
      ).role
    ).toBe("viewer");
    const before = h.counts();
    await refuses(
      () =>
        h.service.createDocument(
          { ...principals.agentOne, agentId: "a2" },
          { title: "Forged" }
        ),
      "not_found"
    );
    h.db
      .update(sessions)
      .set({ workspaceId: "w2" })
      .where(eq(sessions.id, "s-shared"))
      .run();
    await refuses(
      () =>
        h.service.createDocument(principals.agentOne, {
          title: "Foreign session",
        }),
      "not_found"
    );
    await refuses(
      () => h.service.join(principals.agentOne, { artifactId: doc.artifactId }),
      "not_found"
    );
    expect(h.counts()).toEqual(before);
  });

  test("foreign agent, run and current-version parents are refused", async () => {
    const h = setup();
    const doc = await h.create();
    const foreign = await h.service.createDocument(principals.otherWorkspace, {
      title: "Foreign",
    });
    const before = h.counts();
    h.db
      .update(artifacts)
      .set({ currentVersionId: foreign.versionId })
      .where(eq(artifacts.id, doc.artifactId))
      .run();
    await refuses(
      () =>
        h.service.checkpoint(principals.owner, {
          artifactId: doc.artifactId,
          ...encode("Denied", 1),
        }),
      "not_found"
    );
    h.db
      .update(agents)
      .set({ workspaceId: "w2" })
      .where(eq(agents.id, "a1"))
      .run();
    await refuses(
      () =>
        h.service.createDocument(principals.agentOne, {
          title: "Foreign agent",
        }),
      "not_found"
    );
    h.db
      .update(agents)
      .set({ workspaceId: "w1" })
      .where(eq(agents.id, "a1"))
      .run();
    h.db
      .update(runs)
      .set({ workspaceId: "w2" })
      .where(eq(runs.id, "r-shared"))
      .run();
    await refuses(
      () =>
        h.service.createDocument(principals.agentOne, { title: "Foreign run" }),
      "not_found"
    );
    expect(h.counts()).toEqual(before);
  });

  test("restore never follows foreign checkpoint rows and refuses missing state before room RPC", async () => {
    const h = setup();
    const doc = await h.create();
    h.db
      .update(artifactVersions)
      .set({ workspaceId: "w2" })
      .where(eq(artifactVersions.id, doc.versionId))
      .run();
    await refuses(
      () =>
        h.service.restore(principals.owner, {
          artifactId: doc.artifactId,
          version: 1,
        }),
      "not_found"
    );
    h.db
      .update(artifactVersions)
      .set({ workspaceId: "w1" })
      .where(eq(artifactVersions.id, doc.versionId))
      .run();
    h.db
      .update(artifactVersionFiles)
      .set({ workspaceId: "w2" })
      .where(eq(artifactVersionFiles.path, "state.ydoc"))
      .run();
    await refuses(
      () =>
        h.service.restore(principals.owner, {
          artifactId: doc.artifactId,
          version: 1,
        }),
      "not_found"
    );
    h.db.update(artifactVersionFiles).set({ workspaceId: "w1" }).run();
    const state = h.db
      .select()
      .from(artifactVersionFiles)
      .where(eq(artifactVersionFiles.path, "state.ydoc"))
      .get();
    h.blobs.objects.delete(`w1/artifact-blobs/${state?.sha256}`);
    await refuses(
      () =>
        h.service.restore(principals.owner, {
          artifactId: doc.artifactId,
          version: 1,
        }),
      "not_found"
    );
    expect(h.restores).toHaveLength(0);
  });

  test("conversion requires source write permission and a static doc", async () => {
    const h = setup();
    const old = await h.artifacts.create(principals.owner, {
      files: [{ path: "index.md", text: "Secret" }],
      kind: "doc",
      title: "Static",
    });
    const page = await h.artifacts.create(principals.owner, {
      files: [{ path: "index.html", text: "Page" }],
      kind: "page",
      title: "Page",
    });
    const before = h.counts();
    await refuses(
      () =>
        h.service.convertDoc(principals.stranger, {
          artifactId: old.artifactId,
        }),
      "not_found"
    );
    await refuses(
      () =>
        h.service.convertDoc(principals.keyReader, {
          artifactId: old.artifactId,
        }),
      "forbidden"
    );
    await refuses(
      () =>
        h.service.convertDoc(principals.owner, { artifactId: page.artifactId }),
      "invalid"
    );
    expect(h.counts()).toEqual(before);
  });

  test("scoped runs cannot create or escape scope or promote the asker's viewer role", async () => {
    const h = setup();
    const doc = await h.create();
    const second = await h.create();
    h.db
      .update(runs)
      .set({ onBehalfOfUserId: "u2", scopeArtifactId: doc.artifactId })
      .where(eq(runs.id, "r-shared"))
      .run();
    h.grant(doc.artifactId, "viewer");
    expect(
      (
        await h.service.join(principals.agentOne, {
          artifactId: doc.artifactId,
        })
      ).role
    ).toBe("viewer");
    await refuses(
      () =>
        h.service.checkpoint(principals.agentOne, {
          artifactId: doc.artifactId,
          ...encode("Denied", 1),
        }),
      "forbidden"
    );
    await refuses(
      () =>
        h.service.join(principals.agentOne, { artifactId: second.artifactId }),
      "forbidden"
    );
    await refuses(
      () => h.service.createDocument(principals.agentOne, { title: "Escape" }),
      "forbidden"
    );
  });

  test("invalidations call the room and deletion prevents future joins", async () => {
    const h = setup();
    const doc = await h.create();
    await h.service.invalidateAccess(principals.owner, {
      artifactId: doc.artifactId,
      participantId: "u:u2",
    });
    expect(h.refreshes[0]).toEqual({
      participantId: "u:u2",
      scope: { artifactId: doc.artifactId, workspaceId: "w1" },
    });
    await h.service.remove(principals.owner, { artifactId: doc.artifactId });
    expect(h.refreshes).toHaveLength(2);
    await refuses(
      () => h.service.join(principals.owner, { artifactId: doc.artifactId }),
      "not_found"
    );
  });

  test("rejects invalid inputs and non-member callers before writing or invoking rooms", async () => {
    const h = setup();
    const doc = await h.create();
    const before = h.counts();
    await refuses(
      () => h.service.createDocument(principals.owner, { title: " " }),
      "invalid"
    );
    await refuses(
      () => h.service.join({ kind: "system" }, { artifactId: doc.artifactId }),
      "forbidden"
    );
    await refuses(
      () =>
        h.service.checkpoint(principals.owner, {
          artifactId: doc.artifactId,
          revision: 1,
          state: new Uint8Array(LIVE_DOC_MAX_BYTES + 1),
        }),
      "invalid"
    );
    await refuses(
      () =>
        h.service.restore(principals.owner, {
          artifactId: doc.artifactId,
          version: 999,
        }),
      "not_found"
    );
    expect(h.counts()).toEqual(before);
    expect(h.restores).toHaveLength(0);
    expect(() =>
      createLiveArtifactsService({ ...h.deps, ticketKey: " " })
    ).toThrow();
  });
});
