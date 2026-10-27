import { describe, expect, test } from "bun:test";
import {
  artifactPins,
  artifactShares,
  artifacts,
} from "@repo/db/schema/artifacts";
import { events } from "@repo/db/schema/events";
import { workspaces } from "@repo/db/schema/workspaces";
import {
  artifactCardSchema,
  artifactDetailSchema,
  artifactVersionSchema,
} from "@repo/protocol/artifacts";
import { eq } from "drizzle-orm";
import { isForbiddenError } from "../authz.ts";
import { isServiceError } from "../errors.ts";
import type { Principal } from "../workspaces.ts";
import {
  bytes,
  type Harness,
  harness,
  page,
  principals,
  WORKSPACE,
} from "./test-harness.ts";

const NOW = "2026-10-27T00:00:00.000Z";

const code = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    if (isServiceError(error)) {
      return error.code;
    }
    return isForbiddenError(error) ? "forbidden" : "other";
  }
  return "ok";
};

const make = async (
  { service }: Harness,
  principal: Principal,
  title = "Report",
  extra: { kind?: "page" | "doc" | "dashboard" } = {}
) =>
  (
    await service.create(principal, {
      files: page(),
      kind: extra.kind ?? "page",
      title,
    })
  ).artifactId;

/** A private artifact owned by u1 and made outside a session. */
const privateOne = (h: Harness) => make(h, principals.owner, "Secret");

/** A workspace artifact owned by u1. */
const workspaceOne = async (h: Harness, title = "Shared") => {
  const id = await make(h, principals.owner, title);
  await h.service.setAudience(principals.owner, id, "workspace");
  return id;
};

const eventsOf = (h: Harness, type: string) =>
  h.db
    .select()
    .from(events)
    .where(eq(events.type, type))
    .all()
    .map((row) => ({
      ...row,
      payload: JSON.parse(row.payload ?? "{}") as Record<string, unknown>,
    }));

describe("visibility (R1.6)", () => {
  test("a private artifact is open to its owner and the admin only", async () => {
    const h = harness();
    const id = await privateOne(h);
    const open = async (who: Principal) => {
      expect((await h.service.get(who, id)).title).toBe("Secret");
      expect(await h.service.versions(who, id)).toHaveLength(1);
      expect((await h.service.readFile(who, { artifactId: id })).text).toBe(
        "<h1>Hello</h1>"
      );
      expect(
        (await h.service.list(who)).items.map((c) => c.artifactId)
      ).toEqual([id]);
    };
    await open(principals.owner);
    await open(principals.admin);
    expect(await code(h.service.get(principals.stranger, id))).toBe(
      "not_found"
    );
    expect(await code(h.service.versions(principals.stranger, id))).toBe(
      "not_found"
    );
    expect(
      await code(h.service.readFile(principals.stranger, { artifactId: id }))
    ).toBe("not_found");
    expect((await h.service.list(principals.stranger)).items).toEqual([]);
  });

  test("a workspace artifact is visible to a stranger", async () => {
    const h = harness();
    const id = await workspaceOne(h);
    expect((await h.service.get(principals.stranger, id)).artifactId).toBe(id);
    expect(
      (await h.service.list(principals.stranger)).items.map((c) => c.artifactId)
    ).toEqual([id]);
  });

  test("a run sees workspace artifacts and those its own agent made", async () => {
    const h = harness();
    const mine = await h.service.create(principals.agentOneInUi, {
      files: page(),
      kind: "page",
      title: "Mine",
    });
    expect(
      (await h.service.get(principals.agentOneInUi, mine.artifactId)).audience
    ).toBe("private");
    expect(
      await code(h.service.get(principals.agentTwo, mine.artifactId))
    ).toBe("not_found");
    expect((await h.service.list(principals.agentTwo)).items).toEqual([]);
    expect(
      (await h.service.list(principals.agentOne)).items.map((c) => c.artifactId)
    ).toEqual([mine.artifactId]);

    const shared = await workspaceOne(h);
    expect((await h.service.get(principals.agentTwo, shared)).title).toBe(
      "Shared"
    );
  });

  test("another workspace sees nothing", async () => {
    const h = harness();
    const id = await workspaceOne(h);
    expect(await code(h.service.get(principals.otherWorkspace, id))).toBe(
      "not_found"
    );
    expect(await code(h.service.versions(principals.otherWorkspace, id))).toBe(
      "not_found"
    );
    expect((await h.service.list(principals.otherWorkspace)).items).toEqual([]);
  });
});

describe("manage rules", () => {
  const actions = {
    remove: (h: Harness, who: Principal, id: string) =>
      h.service.remove(who, id),
    rename: (h: Harness, who: Principal, id: string) =>
      h.service.rename(who, id, "New title"),
    setAudience: (h: Harness, who: Principal, id: string) =>
      h.service.setAudience(who, id, "workspace"),
  };

  for (const [name, act] of Object.entries(actions)) {
    describe(name, () => {
      for (const [label, who] of [
        ["owner", principals.owner],
        ["admin", principals.admin],
      ] as const) {
        test(`the ${label} may`, async () => {
          const h = harness();
          const id = await privateOne(h);
          await act(h, who, id);
          expect(await eventsOfAll(h)).toContain(eventFor(name));
        });
      }

      test("a stranger gets forbidden on a workspace artifact, not_found on a private one", async () => {
        const h = harness();
        const open = await workspaceOne(h);
        const hidden = await privateOne(h);
        expect(await code(act(h, principals.stranger, open))).toBe("forbidden");
        expect(await code(act(h, principals.stranger, hidden))).toBe(
          "not_found"
        );
        expect((await h.service.get(principals.owner, open)).title).toBe(
          "Shared"
        );
      });

      test("runs and a read-only key are forbidden", async () => {
        const h = harness();
        const id = await workspaceOne(h);
        expect(await code(act(h, principals.agentOne, id))).toBe("forbidden");
        expect(await code(act(h, principals.keyReader, id))).toBe("forbidden");
        expect((await h.service.get(principals.owner, id)).title).toBe(
          "Shared"
        );
      });
    });
  }

  test("rename validates the title length", async () => {
    const h = harness();
    const id = await privateOne(h);
    expect(await code(h.service.rename(principals.owner, id, ""))).toBe(
      "invalid"
    );
    expect(
      await code(h.service.rename(principals.owner, id, "x".repeat(121)))
    ).toBe("invalid");
    await h.service.rename(principals.owner, id, "x".repeat(120));
    expect((await h.service.get(principals.owner, id)).title).toHaveLength(120);
  });

  test("setAudience changes what get shows", async () => {
    const h = harness();
    const id = await privateOne(h);
    await h.service.setAudience(principals.owner, id, "workspace");
    expect((await h.service.get(principals.owner, id)).audience).toBe(
      "workspace"
    );
    await h.service.setAudience(principals.owner, id, "private");
    expect(await code(h.service.get(principals.stranger, id))).toBe(
      "not_found"
    );
  });

  test("a removed artifact is gone and cannot be removed again", async () => {
    const h = harness();
    const id = await workspaceOne(h);
    await h.service.remove(principals.owner, id);
    expect(await code(h.service.get(principals.owner, id))).toBe("not_found");
    expect((await h.service.list(principals.owner)).items).toEqual([]);
    expect(await code(h.service.remove(principals.owner, id))).toBe(
      "not_found"
    );
  });
});

const EVENT_OF = {
  remove: "artifact.deleted",
  rename: "artifact.renamed",
  setAudience: "artifact.audience_changed",
} as const;
const eventFor = (name: string) => EVENT_OF[name as keyof typeof EVENT_OF];
const eventsOfAll = async (h: Harness) =>
  h.db
    .select()
    .from(events)
    .all()
    .map((row) => row.type);

describe("events (R1.34)", () => {
  test("rename writes one artifact.renamed", async () => {
    const h = harness();
    const id = await privateOne(h);
    await h.service.rename(principals.admin, id, "Better");
    const rows = eventsOf(h, "artifact.renamed");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual({
      artifactId: id,
      from: "Secret",
      to: "Better",
    });
    expect(rows[0]?.actorKind).toBe("user");
    expect(rows[0]?.actorId).toBe("adm");
    expect(rows[0]?.runId).toBeNull();
  });

  test("setAudience writes one artifact.audience_changed", async () => {
    const h = harness();
    const id = await privateOne(h);
    await h.service.setAudience(principals.owner, id, "workspace");
    const rows = eventsOf(h, "artifact.audience_changed");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({
      from: "private",
      to: "workspace",
    });
    expect(rows[0]?.actorId).toBe("u1");
    expect(rows[0]?.actorKind).toBe("user");
  });

  test("remove writes one artifact.deleted", async () => {
    const h = harness();
    const id = await privateOne(h);
    await h.service.remove(principals.owner, id);
    const rows = eventsOf(h, "artifact.deleted");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({ artifactId: id, title: "Secret" });
    expect(rows[0]?.actorId).toBe("u1");
  });

  test("restore writes one artifact.restored naming the person", async () => {
    const h = harness();
    const id = await privateOne(h);
    await h.service.update(principals.owner, {
      artifactId: id,
      baseVersion: 1,
      files: page("<h1>Two</h1>"),
    });
    const restored = await h.service.restore(principals.owner, id, 1);
    expect(restored.version).toBe(3);
    const rows = eventsOf(h, "artifact.restored");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({
      artifactId: id,
      fromVersion: 1,
      version: 3,
    });
    expect(rows[0]?.actorKind).toBe("user");
    expect(rows[0]?.actorId).toBe("u1");
  });

  test("a rejected rename writes no event", async () => {
    const h = harness();
    const id = await workspaceOne(h);
    await code(h.service.rename(principals.stranger, id, "Nope"));
    expect(eventsOf(h, "artifact.renamed")).toEqual([]);
  });
});

describe("list", () => {
  test("filters by kind", async () => {
    const h = harness();
    const doc = await h.service.create(principals.owner, {
      files: [{ path: "index.md", text: "# Hi" }],
      kind: "doc",
      title: "Doc",
    });
    await make(h, principals.owner, "Page");
    const { items } = await h.service.list(principals.owner, { kind: "doc" });
    expect(items.map((c) => c.artifactId)).toEqual([doc.artifactId]);
  });

  test("filters by who made it", async () => {
    const h = harness();
    const byPerson = await make(h, principals.owner, "By person");
    const byAgent = (
      await h.service.create(principals.agentOne, {
        files: page(),
        kind: "page",
        title: "By agent",
      })
    ).artifactId;
    const ids = async (madeBy: "agent" | "person") =>
      (await h.service.list(principals.owner, { madeBy })).items.map(
        (c) => c.artifactId
      );
    expect(await ids("agent")).toEqual([byAgent]);
    expect(await ids("person")).toEqual([byPerson]);
  });

  test("the shared filter and linkCount count active links only", async () => {
    const h = harness();
    const active = await workspaceOne(h, "Active");
    const revoked = await workspaceOne(h, "Revoked");
    const expired = await workspaceOne(h, "Expired");
    const none = await workspaceOne(h, "None");
    const share = (
      artifactId: string,
      n: string,
      extra: { expiresAt?: string; revokedAt?: string } = {}
    ) =>
      h.db
        .insert(artifactShares)
        .values({
          artifactId,
          createdAt: NOW,
          createdBy: "u1",
          id: `sh-${n}`,
          kind: "link",
          tokenEncrypted: "enc",
          tokenHash: `hash-${n}`,
          workspaceId: WORKSPACE,
          ...extra,
        })
        .run();
    share(active, "a1");
    share(active, "a2");
    share(revoked, "r", { revokedAt: NOW });
    share(expired, "e", { expiresAt: "2020-01-01T00:00:00.000Z" });

    const shared = await h.service.list(principals.owner, { shared: true });
    expect(shared.items.map((c) => c.artifactId)).toEqual([active]);
    expect(shared.items[0]?.linkCount).toBe(2);

    const all = await h.service.list(principals.owner);
    const counts = Object.fromEntries(
      all.items.map((c) => [c.artifactId, c.linkCount])
    );
    expect(counts).toEqual({
      [active]: 2,
      [expired]: 0,
      [none]: 0,
      [revoked]: 0,
    });
  });

  test("orders by updatedAt, newest first", async () => {
    const h = harness();
    const a = await make(h, principals.owner, "A");
    const b = await make(h, principals.owner, "B");
    const c = await make(h, principals.owner, "C");
    const at = (id: string, updatedAt: string) =>
      h.db
        .update(artifacts)
        .set({ updatedAt })
        .where(eq(artifacts.id, id))
        .run();
    at(a, "2026-10-27T03:00:00.000Z");
    at(b, "2026-10-27T01:00:00.000Z");
    at(c, "2026-10-27T02:00:00.000Z");
    expect(
      (await h.service.list(principals.owner)).items.map((x) => x.artifactId)
    ).toEqual([a, c, b]);
    await h.service.rename(principals.owner, b, "B2");
    expect((await h.service.list(principals.owner)).items[0]?.artifactId).toBe(
      b
    );
  });

  test("pages by 50 with a cursor", async () => {
    const h = harness();
    const made: string[] = [];
    for (let n = 0; n < 55; n += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each create must finish before the next so ids and times differ
      made.push(await make(h, principals.owner, `Item ${n}`));
    }
    const first = await h.service.list(principals.owner);
    expect(first.items).toHaveLength(50);
    expect(first.next).toBeDefined();
    const second = await h.service.list(principals.owner, {
      cursor: first.next,
    });
    expect(second.items).toHaveLength(5);
    expect(second.next).toBeUndefined();
    const seen = [...first.items, ...second.items].map((x) => x.artifactId);
    expect(new Set(seen).size).toBe(55);
    expect(new Set(seen)).toEqual(new Set(made));
  });

  test("a malformed cursor is invalid", async () => {
    const h = harness();
    for (const cursor of ["nonsense", "~abc", "abc~"]) {
      expect(
        // biome-ignore lint/performance/noAwaitInLoops: cases run in order
        await code(h.service.list(principals.owner, { cursor }))
      ).toBe("invalid");
    }
  });

  test("cards carry agent name, owner, thumbnail flag, version and pin", async () => {
    const h = harness();
    const mine = await make(h, principals.owner, "Pinned");
    const byAgent = (
      await h.service.create(principals.agentOne, {
        files: page(),
        kind: "page",
        title: "Agent made",
      })
    ).artifactId;
    h.db
      .insert(artifactPins)
      .values({
        artifactId: mine,
        createdAt: NOW,
        id: "pin1",
        position: 0,
        surface: "sidebar",
        userId: "u1",
        workspaceId: WORKSPACE,
      })
      .run();
    await h.service.update(principals.owner, {
      artifactId: mine,
      baseVersion: 1,
      files: page("two"),
    });
    const { items } = await h.service.list(principals.owner);
    const card = (id: string) => items.find((x) => x.artifactId === id);
    for (const item of items) {
      artifactCardSchema.parse(item);
      expect(item.hasThumbnail).toBe(false);
    }
    expect(card(mine)).toMatchObject({
      agentName: null,
      currentVersion: 2,
      ownerUserId: "u1",
      pinned: true,
    });
    expect(card(byAgent)).toMatchObject({
      agentName: "Agent a1",
      currentVersion: 1,
      ownerUserId: "u1",
      pinned: false,
    });
    const other = await h.service.list(principals.admin);
    expect(other.items.every((x) => !x.pinned)).toBe(true);
  });
});

describe("get", () => {
  test("canManage and canCreateLiveLink follow the viewer", async () => {
    const h = harness();
    const id = await workspaceOne(h);
    const flags = async (who: Principal) => {
      const d = await h.service.get(who, id);
      return [d.canManage, d.canCreateLiveLink];
    };
    expect(await flags(principals.owner)).toEqual([true, true]);
    expect(await flags(principals.admin)).toEqual([true, false]);
    expect(await flags(principals.stranger)).toEqual([false, false]);
    expect(await flags(principals.agentTwo)).toEqual([false, false]);
  });

  test("linksEnabled follows the workspace setting", async () => {
    const h = harness();
    const id = await privateOne(h);
    expect((await h.service.get(principals.owner, id)).linksEnabled).toBe(true);
    h.db
      .update(workspaces)
      .set({ artifactLinksEnabled: false })
      .where(eq(workspaces.id, WORKSPACE))
      .run();
    expect((await h.service.get(principals.owner, id)).linksEnabled).toBe(
      false
    );
  });

  test("madeIn names the run's session when the viewer can see it", async () => {
    const h = harness();
    const fromShared = (
      await h.service.create(principals.agentOne, {
        files: page(),
        kind: "page",
        title: "From shared",
      })
    ).artifactId;
    const detail = await h.service.get(principals.owner, fromShared);
    expect(detail.madeIn).toEqual({
      runId: "r-shared",
      sessionId: "s-shared",
      title: null,
    });
    expect(
      (await h.service.get(principals.owner, await privateOne(h))).madeIn
    ).toBeNull();
  });

  test("madeIn is null for a viewer who cannot see a ui session", async () => {
    const h = harness();
    const fromUi = (
      await h.service.create(principals.agentOneInUi, {
        files: page(),
        kind: "page",
        title: "From ui",
      })
    ).artifactId;
    expect((await h.service.get(principals.owner, fromUi)).madeIn).toEqual({
      runId: "r-ui",
      sessionId: "s-ui",
      title: null,
    });
    await h.service.setAudience(principals.owner, fromUi, "workspace");
    const seen = await h.service.get(principals.stranger, fromUi);
    expect(seen.madeIn).toBeNull();
    expect(seen.title).toBe("From ui");
  });

  test("the detail matches the protocol schema", async () => {
    const h = harness();
    const id = await privateOne(h);
    const detail = await h.service.get(principals.owner, id);
    artifactDetailSchema.parse(detail);
    expect(detail.currentVersion).toMatchObject({
      authorId: "u1",
      authorKind: "user",
      entry: "index.html",
      fileCount: 1,
      hasThumbnail: false,
      number: 1,
      parentNumber: null,
      status: "published",
    });
  });
});

describe("versions", () => {
  test("lists newest first with the parent chain", async () => {
    const h = harness();
    const id = await privateOne(h);
    await h.service.update(principals.owner, {
      artifactId: id,
      baseVersion: 1,
      files: page("two"),
    });
    await h.service.restore(principals.owner, id, 1);
    const list = await h.service.versions(principals.owner, id);
    for (const v of list) {
      artifactVersionSchema.parse(v);
    }
    expect(list.map((v) => [v.number, v.parentNumber])).toEqual([
      [3, 2],
      [2, 1],
      [1, null],
    ]);
    expect(list[0]?.message).toBe("Restored version 1");
  });
});

describe("readFile", () => {
  const withFiles = async () => {
    const h = harness();
    const created = await h.service.create(principals.owner, {
      files: [
        { path: "index.html", text: "<h1>One</h1>" },
        { path: "notes.txt", text: "first notes" },
        { base64: Buffer.from(bytes("png")).toString("base64"), path: "a.png" },
      ],
      kind: "page",
      title: "Files",
    });
    await h.service.update(principals.owner, {
      artifactId: created.artifactId,
      baseVersion: 1,
      files: [
        { path: "index.html", text: "<h1>Two</h1>" },
        { path: "notes.txt", text: "second notes" },
      ],
    });
    return { h, id: created.artifactId };
  };

  test("reads the entry of the current version by default", async () => {
    const { h, id } = await withFiles();
    const read = await h.service.readFile(principals.owner, { artifactId: id });
    expect(read).toMatchObject({
      path: "index.html",
      text: "<h1>Two</h1>",
      version: 2,
    });
  });

  test("reads an explicit path and an older version", async () => {
    const { h, id } = await withFiles();
    expect(
      (
        await h.service.readFile(principals.owner, {
          artifactId: id,
          path: "notes.txt",
        })
      ).text
    ).toBe("second notes");
    const old = await h.service.readFile(principals.owner, {
      artifactId: id,
      path: "notes.txt",
      version: 1,
    });
    expect(old).toMatchObject({ text: "first notes", version: 1 });
    expect(old.contentType).toStartWith("text/plain");
  });

  test("an unknown path or version is not_found", async () => {
    const { h, id } = await withFiles();
    expect(
      await code(
        h.service.readFile(principals.owner, {
          artifactId: id,
          path: "missing.txt",
        })
      )
    ).toBe("not_found");
    expect(
      await code(
        h.service.readFile(principals.owner, { artifactId: id, version: 9 })
      )
    ).toBe("not_found");
    expect(
      await code(
        h.service.readFile(principals.owner, {
          artifactId: id,
          path: "a.png",
          version: 2,
        })
      )
    ).toBe("not_found");
  });

  test("a binary file is invalid", async () => {
    const { h, id } = await withFiles();
    expect(
      await code(
        h.service.readFile(principals.owner, {
          artifactId: id,
          path: "a.png",
          version: 1,
        })
      )
    ).toBe("invalid");
  });
});
