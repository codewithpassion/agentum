import { beforeEach, describe, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import {
  artifactShares,
  artifacts,
  artifactVersions,
  artifactViewSalts,
  artifactViews,
} from "@repo/db/schema/artifacts";
import { events as eventRows } from "@repo/db/schema/events";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import {
  ARTIFACT_VIEW_TOKEN_PREFIX,
  parseArtifactContentPath,
} from "@repo/protocol/artifacts";
import { eq } from "drizzle-orm";
import { ForbiddenError } from "../authz.ts";
import { hashToken } from "../crypto.ts";
import { ServiceError } from "../errors.ts";
import { createEventsService } from "../events.ts";
import type { Principal } from "../workspaces.ts";
import {
  type ArtifactSharesService,
  createArtifactSharesService,
  type ShareGrant,
  type ShareRequestInfo,
} from "./shares.ts";
import { verifyViewToken } from "./view-token.ts";

const W1 = "w1";
const W2 = "w2";
const START = "2026-10-27T10:00:00.000Z";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const VIEW_KEY = "test-view-key";
const ORIGIN = "https://hm.test";
const ARTIFACT = crypto.randomUUID();
const OTHER_ARTIFACT = crypto.randomUUID();
const IP = "203.0.113.77";
const IP6 = "2001:db8:1234:5678::9";

const user = (userId: string, isAdmin = false): Principal => ({
  isAdmin,
  kind: "user",
  userId,
  via: "session",
  workspaceId: W1,
});
const owner = user("u_owner");
const member = user("u_member");
const admin = user("u_admin", true);
const keyUser: Principal = {
  kind: "user",
  userId: "u_owner",
  via: "api_key",
  workspaceId: W1,
};
const outsider: Principal = {
  isAdmin: true,
  kind: "user",
  userId: "u_other",
  via: "session",
  workspaceId: W2,
};
const run = (agentId: string): Principal => ({
  agentId,
  kind: "run",
  runId: "run1",
  workspaceId: W1,
});

const request = (
  overrides: Partial<ShareRequestInfo> = {}
): ShareRequestInfo => ({
  cf: {
    asn: 64_500,
    asOrganization: "Example Net",
    city: "Sydney",
    country: "AU",
    region: "New South Wales",
  },
  ip: IP,
  referrer: "https://mail.example.com/inbox/42?token=refsecret-q7x",
  userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
  ...overrides,
});

let db: ReturnType<typeof migrated>;
let nowMs: number;
let service: ArtifactSharesService;
let secretsKey: string;
let versionIds: { v1: string; v2: string };

const build = (overrides: { linksOff?: boolean; viewKey?: string } = {}) => {
  const store = new Map<string, string>();
  return createArtifactSharesService({
    atomic: sqliteAtomic(db),
    clock: { now: () => new Date(nowMs) },
    db,
    events: createEventsService({
      blobs: {
        get: (key) => Promise.resolve(store.get(key) ?? null),
        put: (key, body) => {
          store.set(key, body);
          return Promise.resolve();
        },
      },
      db,
    }),
    origin: ORIGIN,
    people: (ids) =>
      Promise.resolve(
        new Map(ids.map((id) => [id, { email: null, name: `Name of ${id}` }]))
      ),
    secretsKey,
    viewKey: VIEW_KEY,
    ...overrides,
  });
};

const advance = (ms: number) => {
  nowMs += ms;
};

const seedWorkspace = (id: string) =>
  db
    .insert(workspaces)
    .values({
      clerkOrgId: `org_${id}`,
      createdAt: START,
      id,
      name: `Workspace ${id}`,
      timezone: "UTC",
    })
    .run();

const seedArtifact = (
  id: string,
  audience: "private" | "workspace",
  agentId: string | null
) =>
  db
    .insert(artifacts)
    .values({
      agentId,
      audience,
      createdAt: START,
      createdById: "u_owner",
      createdByKind: "user",
      id,
      kind: "page",
      ownerUserId: "u_owner",
      title: "Market summary",
      updatedAt: START,
      workspaceId: W1,
    })
    .run();

const seedVersion = (artifactId: string, id: string, number: number) =>
  db
    .insert(artifactVersions)
    .values({
      artifactId,
      authorId: "u_owner",
      authorKind: "user",
      createdAt: START,
      entry: "index.html",
      fileCount: 1,
      id,
      manifestKey: `${W1}/artifact-manifests/${id}.json`,
      message: "m",
      number,
      status: "published",
      totalBytes: 1,
      workspaceId: W1,
    })
    .run();

beforeEach(() => {
  db = migrated();
  nowMs = Date.parse(START);
  secretsKey = btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))
  );
  seedWorkspace(W1);
  seedWorkspace(W2);
  db.insert(agents)
    .values({
      createdAt: START,
      createdBy: "u_owner",
      id: "agent_maker",
      instructions: "x",
      model: "m",
      name: "Research agent",
      runtime: "fake",
      runtimeConfig: "{}",
      slug: "maker",
      status: "active",
      workspaceId: W1,
    })
    .run();
  seedArtifact(ARTIFACT, "workspace", "agent_maker");
  seedVersion(ARTIFACT, "v1", 1);
  seedVersion(ARTIFACT, "v2", 2);
  db.update(artifacts)
    .set({ currentVersionId: "v2" })
    .where(eq(artifacts.id, ARTIFACT))
    .run();
  versionIds = { v1: "v1", v2: "v2" };
  seedArtifact(OTHER_ARTIFACT, "private", "agent_maker");
  seedVersion(OTHER_ARTIFACT, "p1", 1);
  db.update(artifacts)
    .set({ currentVersionId: "p1" })
    .where(eq(artifacts.id, OTHER_ARTIFACT))
    .run();
  service = build();
});

const eventsOf = (type: string) =>
  db.select().from(eventRows).where(eq(eventRows.type, type)).all();

/** Every stored value of every table, as one string. */
const dumpDatabase = (): string => {
  const tables = db.client
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite_%'"
    )
    .all();
  return tables
    .map(({ name }) =>
      JSON.stringify(db.client.query(`SELECT * FROM "${name}"`).all())
    )
    .join("\n");
};

const HEX_64 = /^[0-9a-f]{64}$/;

/** The view token inside a content URL. */
const viewTokenOf = (contentUrl: string): string => {
  const parsed = parseArtifactContentPath(contentUrl);
  if (!parsed) {
    throw new Error(`Not a content URL: ${contentUrl}`);
  }
  return parsed.token;
};

const claimsOf = (contentUrl: string) =>
  verifyViewToken(viewTokenOf(contentUrl), VIEW_KEY, nowMs / 1000);

const tokenOf = (url: string): string => url.slice(`${ORIGIN}/s/`.length);

describe("member open", () => {
  test("a member gets a content URL with a member token for the current version and one view row (R1.31)", async () => {
    const opened = await service.open(member, {
      artifactId: ARTIFACT,
      surface: "viewer",
    });
    expect(opened.version).toEqual({ createdAt: START, number: 2 });
    expect(parseArtifactContentPath(opened.contentUrl)?.artifactId).toBe(
      ARTIFACT
    );
    const claims = await claimsOf(opened.contentUrl);
    expect(claims).toMatchObject({
      artifactId: ARTIFACT,
      userId: "u_member",
      versionId: "v2",
      viewer: "member",
      workspaceId: W1,
    });
    expect(claims?.expiresAt).toBe(nowMs / 1000 + 3600);
    expect(opened.expiresAt).toBe(new Date(nowMs + HOUR).toISOString());
    const rows = db.select().from(artifactViews).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: "ok",
      shareId: null,
      surface: "viewer",
      userId: "u_member",
      versionId: "v2",
    });
  });

  test("a chosen version number opens that version, and a thread open records surface thread", async () => {
    const opened = await service.open(member, {
      artifactId: ARTIFACT,
      surface: "thread",
      version: 1,
    });
    expect(opened.version.number).toBe(1);
    expect(db.select().from(artifactViews).get()).toMatchObject({
      surface: "thread",
      versionId: "v1",
    });
    await expect(
      service.open(member, {
        artifactId: ARTIFACT,
        surface: "viewer",
        version: 9,
      })
    ).rejects.toMatchObject({ code: "not_found" });
  });

  test("a private artifact opens for its owner and admins, not for other members", async () => {
    const input = { artifactId: OTHER_ARTIFACT, surface: "viewer" } as const;
    await expect(service.open(member, input)).rejects.toBeInstanceOf(
      ServiceError
    );
    await service.open(owner, input);
    await service.open(admin, input);
    expect(db.select().from(artifactViews).all()).toHaveLength(2);
  });

  test("a deleted artifact and an artifact of another workspace are not found", async () => {
    db.update(artifacts)
      .set({ deletedAt: START })
      .where(eq(artifacts.id, ARTIFACT))
      .run();
    await expect(
      service.open(owner, { artifactId: ARTIFACT, surface: "viewer" })
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      service.open(outsider, { artifactId: OTHER_ARTIFACT, surface: "viewer" })
    ).rejects.toMatchObject({ code: "not_found" });
  });

  test("an agent run cannot use the member open", async () => {
    await expect(
      service.open(run("agent_maker"), {
        artifactId: ARTIFACT,
        surface: "viewer",
      })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("artifact_test token", () => {
  test("mints a 5 minute test token for the run's agent and writes a test view row", async () => {
    const minted = await service.mintTestToken(run("agent_maker"), {
      artifactId: OTHER_ARTIFACT,
      versionId: "p1",
    });
    const claims = await claimsOf(minted.contentUrl);
    expect(claims).toMatchObject({
      artifactId: OTHER_ARTIFACT,
      versionId: "p1",
      viewer: "test",
      workspaceId: W1,
    });
    expect(claims?.expiresAt).toBe(nowMs / 1000 + 300);
    expect(claims?.userId).toBeUndefined();
    expect(db.select().from(artifactViews).get()).toMatchObject({
      outcome: "ok",
      surface: "test",
      userId: null,
    });
  });

  test("another agent cannot test a private artifact, and a version of another artifact is refused", async () => {
    await expect(
      service.mintTestToken(run("agent_other"), {
        artifactId: OTHER_ARTIFACT,
        versionId: "p1",
      })
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      service.mintTestToken(run("agent_maker"), {
        artifactId: OTHER_ARTIFACT,
        versionId: "v1",
      })
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      service.mintTestToken(member, {
        artifactId: ARTIFACT,
        versionId: "v1",
      })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("link shares", () => {
  test("the owner creates many links with an expiry and a pinned version, and copies them again later (R1.27)", async () => {
    const expiresAt = new Date(nowMs + 7 * DAY).toISOString();
    const first = await service.createShare(owner, {
      artifactId: ARTIFACT,
      expiresAt,
      versionId: "v1",
    });
    const second = await service.createShare(owner, { artifactId: ARTIFACT });
    expect(first).toMatchObject({
      createdBy: "u_owner",
      dataMode: "snapshot",
      expiresAt,
      grantedBy: null,
      openCount: 0,
      status: "active",
      versionId: "v1",
    });
    expect(second.expiresAt).toBeNull();
    expect(second.versionId).toBeNull();
    expect(first.url).toStartWith(`${ORIGIN}/s/ag_share_`);
    expect(first.url).not.toBe(second.url);

    advance(HOUR);
    const listed = await service.shares(owner, { artifactId: ARTIFACT });
    expect(listed.map((s) => s.url).sort()).toEqual(
      [first.url, second.url].sort()
    );
    const asAdmin = await service.shares(admin, { artifactId: ARTIFACT });
    expect(asAdmin.map((s) => s.url).sort()).toEqual(
      [first.url, second.url].sort()
    );
  });

  test("a member who may open the artifact sees the links without their tokens", async () => {
    const share = await service.createShare(owner, { artifactId: ARTIFACT });
    const listed = await service.shares(member, { artifactId: ARTIFACT });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: share.id, status: "active" });
    expect(listed[0]?.url).toBe(`${ORIGIN}/s/`);
    expect(JSON.stringify(listed)).not.toContain("ag_share_");
  });

  test("a link whose stored token no longer decrypts lists without its token and still opens", async () => {
    const share = await service.createShare(owner, { artifactId: ARTIFACT });
    // The cutover to Agentum v2 rotated SECRETS_KEY: the ciphertext stays, the key that made it is gone.
    secretsKey = btoa(
      String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))
    );
    const rotated = build();
    const listed = await rotated.shares(owner, { artifactId: ARTIFACT });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: share.id, status: "active" });
    expect(listed[0]?.url).toBe(`${ORIGIN}/s/`);
    expect(await rotated.openLink(tokenOf(share.url), request())).toMatchObject(
      { ok: true }
    );
  });

  test("an API key or an agent cannot read links, open as a member or read the log", async () => {
    for (const caller of [keyUser, run("agent_maker")]) {
      // biome-ignore lint/performance/noAwaitInLoops: the calls run one after another on purpose
      await expect(
        service.shares(caller, { artifactId: ARTIFACT })
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        service.open(caller, { artifactId: ARTIFACT, surface: "viewer" })
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        service.views(caller, { artifactId: ARTIFACT })
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  test("the row keeps the hash and an encrypted copy, never the token (R1.13)", async () => {
    const share = await service.createShare(owner, { artifactId: ARTIFACT });
    const token = tokenOf(share.url);
    const row = db.select().from(artifactShares).get();
    expect(row?.tokenHash).toMatch(HEX_64);
    expect(row?.tokenEncrypted).toStartWith("v1:");
    expect(dumpDatabase()).not.toContain(token);
  });

  test("an admin can create and revoke any link", async () => {
    const share = await service.createShare(admin, {
      artifactId: OTHER_ARTIFACT,
    });
    expect(share.createdBy).toBe("u_admin");
    await service.revokeShare(admin, { shareId: share.id });
    expect(db.select().from(artifactShares).get()?.revokedBy).toBe("u_admin");
  });

  test("other members, API keys and agents cannot create or revoke links (R1.30)", async () => {
    const share = await service.createShare(owner, { artifactId: ARTIFACT });
    for (const caller of [member, keyUser, run("agent_maker")]) {
      // biome-ignore lint/performance/noAwaitInLoops: the calls run one after another on purpose
      await expect(
        service.createShare(caller, { artifactId: ARTIFACT })
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        service.revokeShare(caller, { shareId: share.id })
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(db.select().from(artifactShares).all()).toHaveLength(1);
    expect(eventsOf("artifact.share_revoked")).toHaveLength(0);
  });

  test("a member who cannot open the artifact does not learn it exists", async () => {
    await expect(
      service.createShare(member, { artifactId: OTHER_ARTIFACT })
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      service.shares(member, { artifactId: OTHER_ARTIFACT })
    ).rejects.toMatchObject({ code: "not_found" });
  });

  test("live links, past expiries and versions of another artifact are refused", async () => {
    await expect(
      service.createShare(owner, {
        artifactId: ARTIFACT,
        dataMode: "live",
        liveTools: ["x"],
      })
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      service.createShare(owner, {
        artifactId: ARTIFACT,
        expiresAt: new Date(nowMs - 1000).toISOString(),
      })
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      service.createShare(owner, { artifactId: ARTIFACT, versionId: "p1" })
    ).rejects.toMatchObject({ code: "not_found" });
    expect(db.select().from(artifactShares).all()).toHaveLength(0);
  });

  test("create and revoke each write one event that names the person and holds no token (R1.34, R1.13)", async () => {
    const share = await service.createShare(owner, { artifactId: ARTIFACT });
    await service.revokeShare(owner, { shareId: share.id });
    await service.revokeShare(owner, { shareId: share.id });
    const created = eventsOf("artifact.share_created");
    const revoked = eventsOf("artifact.share_revoked");
    expect(created).toHaveLength(1);
    expect(revoked).toHaveLength(1);
    expect(created[0]).toMatchObject({ actorId: "u_owner", actorKind: "user" });
    expect(revoked[0]).toMatchObject({ actorId: "u_owner", actorKind: "user" });
    expect(JSON.parse(created[0]?.payload ?? "{}")).toMatchObject({
      artifactId: ARTIFACT,
      shareId: share.id,
    });
    expect(JSON.stringify([created, revoked])).not.toContain(
      tokenOf(share.url)
    );
    expect(JSON.stringify([created, revoked])).not.toContain("ag_share_");
  });

  test("status is revoked, expired or active, and revoked wins", async () => {
    const expiring = await service.createShare(owner, {
      artifactId: ARTIFACT,
      expiresAt: new Date(nowMs + HOUR).toISOString(),
    });
    const plain = await service.createShare(owner, { artifactId: ARTIFACT });
    await service.revokeShare(owner, { shareId: expiring.id });
    advance(2 * HOUR);
    const statuses = Object.fromEntries(
      (await service.shares(owner, { artifactId: ARTIFACT })).map((s) => [
        s.id,
        s.status,
      ])
    );
    expect(statuses).toEqual({
      [expiring.id]: "revoked",
      [plain.id]: "active",
    });
  });

  test("a link of another workspace is not found", async () => {
    const share = await service.createShare(owner, { artifactId: ARTIFACT });
    await expect(
      service.revokeShare(outsider, { shareId: share.id })
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("link open", () => {
  const create = async (
    input: { expiresAt?: string; versionId?: string } = {}
  ) => {
    const share = await service.createShare(owner, {
      artifactId: ARTIFACT,
      ...input,
    });
    return { share, token: tokenOf(share.url) };
  };

  test("a live link resolves to a grant and the share page data, and counts the open (R1.28, R1.31)", async () => {
    const { share, token } = await create();
    const result = await service.openLink(token, request());
    if (!result.ok) {
      throw new Error("expected the link to open");
    }
    expect(result.grant).toEqual({
      artifactId: ARTIFACT,
      kind: "share_grant",
      shareId: share.id,
      versionId: "v2",
      workspaceId: W1,
    });
    expect(result.response).toMatchObject({
      agentName: "Research agent",
      kind: "page",
      ownerName: "Name of u_owner",
      title: "Market summary",
      version: { createdAt: START, number: 2 },
      workspaceName: "Workspace w1",
    });
    const claims = await claimsOf(result.response.contentUrl);
    expect(claims).toMatchObject({
      artifactId: ARTIFACT,
      shareId: share.id,
      versionId: "v2",
      viewer: "link",
      workspaceId: W1,
    });
    expect(claims?.userId).toBeUndefined();
    expect(claims?.expiresAt).toBe(nowMs / 1000 + 3600);
    const [after] = await service.shares(owner, { artifactId: ARTIFACT });
    expect(after).toMatchObject({ lastOpenedAt: START, openCount: 1 });
  });

  test("the view row has the IP prefix, visitor hash, place, network, cut user agent and referrer host, and no full IP (R1.31)", async () => {
    const { share, token } = await create();
    await service.openLink(
      token,
      request({ userAgent: `Browser/${"x".repeat(400)}` })
    );
    const row = db.select().from(artifactViews).get();
    expect(row).toMatchObject({
      asn: "64500",
      asOrg: "Example Net",
      city: "Sydney",
      country: "AU",
      ipPrefix: "203.0.113.0/24",
      outcome: "ok",
      referrerHost: "mail.example.com",
      region: "New South Wales",
      shareId: share.id,
      surface: "share",
      userId: null,
      versionId: "v2",
    });
    expect(row?.visitorHash).toMatch(HEX_64);
    expect(row?.userAgent).toHaveLength(256);
    expect(dumpDatabase()).not.toContain(IP);
    expect(dumpDatabase()).not.toContain(token);
    expect(dumpDatabase()).not.toContain("refsecret-q7x");
  });

  test("an IPv6 visitor keeps a /48 prefix only", async () => {
    const { token } = await create();
    await service.openLink(token, request({ ip: IP6 }));
    expect(db.select().from(artifactViews).get()?.ipPrefix).toBe(
      "2001:db8:1234::/48"
    );
    expect(dumpDatabase()).not.toContain(IP6);
  });

  test("the visitor hash repeats within a day and changes the next day once the old salt is gone", async () => {
    const { token } = await create();
    await service.openLink(token, request());
    await service.openLink(token, request());
    await service.openLink(token, request({ ip: "198.51.100.5" }));
    advance(DAY);
    await service.openLink(token, request());
    const hashes = db
      .select()
      .from(artifactViews)
      .all()
      .map((row) => row.visitorHash);
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[2]).not.toBe(hashes[0]);
    expect(hashes[3]).not.toBe(hashes[0]);
    expect(db.select().from(artifactViewSalts).all()).toHaveLength(2);
  });

  test("a request without an address stores no prefix and no hash", async () => {
    const { token } = await create();
    await service.openLink(
      token,
      request({ cf: null, ip: null, referrer: null })
    );
    expect(db.select().from(artifactViews).get()).toMatchObject({
      city: null,
      ipPrefix: null,
      referrerHost: null,
      visitorHash: null,
    });
  });

  test("revoked, expired and disabled links answer the same as an unknown token and record their outcome (R1.29, R1.32)", async () => {
    const revoked = await create();
    const expiring = await create({
      expiresAt: new Date(nowMs + HOUR).toISOString(),
    });
    const switched = await create();
    await service.revokeShare(owner, { shareId: revoked.share.id });
    advance(2 * HOUR);
    await service.setLinksEnabled(admin, { enabled: false });
    const unknown = await service.openLink("hm_share_nope", request());
    const results = await Promise.all([
      service.openLink(revoked.token, request()),
      service.openLink(expiring.token, request()),
      service.openLink(switched.token, request()),
    ]);
    expect(unknown).toEqual({ ok: false });
    for (const result of results) {
      expect(result).toEqual(unknown);
    }
    const byShare = new Map(
      db
        .select()
        .from(artifactViews)
        .all()
        .map((row) => [row.shareId, row.outcome])
    );
    expect(byShare.get(revoked.share.id)).toBe("revoked");
    expect(byShare.get(expiring.share.id)).toBe("expired");
    expect(byShare.get(switched.share.id)).toBe("disabled");
    expect(db.select().from(artifactViews).all()).toHaveLength(3);
    for (const share of db.select().from(artifactShares).all()) {
      expect(share.openCount).toBe(0);
    }
  });

  test("unknown tokens and tokens without the prefix write no row", async () => {
    await create();
    expect(await service.openLink("hm_share_unknown", request())).toEqual({
      ok: false,
    });
    expect(await service.openLink("not-a-token", request())).toEqual({
      ok: false,
    });
    expect(db.select().from(artifactViews).all()).toHaveLength(0);
  });

  test("a link from before the rename, hm_share_, still opens", async () => {
    const { share, token } = await create();
    expect(token).toStartWith("ag_share_");
    const legacy = `hm_share_${token.slice("ag_share_".length)}`;
    db.update(artifactShares)
      .set({ tokenHash: await hashToken(legacy) })
      .where(eq(artifactShares.id, share.id))
      .run();
    expect((await service.openLink(legacy, request())).ok).toBe(true);
  });

  test("turning the workspace switch back on reopens existing links", async () => {
    const { token } = await create();
    await service.setLinksEnabled(admin, { enabled: false });
    expect((await service.openLink(token, request())).ok).toBe(false);
    await service.setLinksEnabled(admin, { enabled: true });
    expect((await service.openLink(token, request())).ok).toBe(true);
  });

  test("ARTIFACT_LINKS_OFF stops every link open and creation (R1.36)", async () => {
    const { token } = await create();
    const off = build({ linksOff: true });
    expect(await off.openLink(token, request())).toEqual({ ok: false });
    expect(
      db.select().from(artifactViews).orderBy(artifactViews.id).all().at(-1)
        ?.outcome
    ).toBe("disabled");
    await expect(
      off.createShare(owner, { artifactId: ARTIFACT })
    ).rejects.toMatchObject({ code: "invalid" });
  });

  test("a missing view key refuses a link like a dead one and writes no view row", async () => {
    const { token } = await create();
    const before = db.select().from(artifactViews).all().length;
    const keyless = build({ viewKey: "" });
    expect(await keyless.openLink(token, request())).toEqual({ ok: false });
    expect(db.select().from(artifactViews).all()).toHaveLength(before);
    await expect(
      keyless.open(owner, { artifactId: ARTIFACT, surface: "viewer" })
    ).rejects.toMatchObject({ code: "invalid" });
  });

  test("a deleted artifact's links stop opening", async () => {
    const { token } = await create();
    db.update(artifacts)
      .set({ deletedAt: START })
      .where(eq(artifacts.id, ARTIFACT))
      .run();
    expect(await service.openLink(token, request())).toEqual({ ok: false });
    expect(db.select().from(artifactViews).get()?.outcome).toBe("revoked");
  });

  test("a pinned link keeps its version, an unpinned link follows the current one", async () => {
    const pinned = await create({ versionId: versionIds.v1 });
    const following = await create();
    const pinnedResult = await service.openLink(pinned.token, request());
    const followingResult = await service.openLink(following.token, request());
    expect(pinnedResult.ok && pinnedResult.grant.versionId).toBe("v1");
    expect(followingResult.ok && followingResult.grant.versionId).toBe("v2");
  });

  test("the view token never outlives the link, and never an hour", async () => {
    const { token } = await create({
      expiresAt: new Date(nowMs + 10 * 60 * 1000).toISOString(),
    });
    const result = await service.openLink(token, request());
    if (!result.ok) {
      throw new Error("expected the link to open");
    }
    const claims = await claimsOf(result.response.contentUrl);
    expect(claims?.expiresAt).toBe(nowMs / 1000 + 600);
    expect(result.response.expiresAt).toBe(
      new Date(nowMs + 10 * 60 * 1000).toISOString()
    );
  });
});

describe("workspace switch", () => {
  test("only admins switch, and each switch writes one event naming them (R1.34)", async () => {
    for (const caller of [owner, member, keyUser]) {
      // biome-ignore lint/performance/noAwaitInLoops: the calls run one after another on purpose
      await expect(
        service.setLinksEnabled(caller, { enabled: false })
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(eventsOf("artifact.links_switched")).toHaveLength(0);
    await service.setLinksEnabled(admin, { enabled: false });
    const rows = eventsOf("artifact.links_switched");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: "u_admin", actorKind: "user" });
    expect(JSON.parse(rows[0]?.payload ?? "{}")).toEqual({ enabled: false });
    expect(
      db.select().from(workspaces).where(eq(workspaces.id, W1)).get()
        ?.artifactLinksEnabled
    ).toBe(false);
    expect(
      db.select().from(workspaces).where(eq(workspaces.id, W2)).get()
        ?.artifactLinksEnabled
    ).toBe(true);
  });

  test("any member reads the switch, a run does not", async () => {
    expect(await service.linksEnabled(member)).toBe(true);
    await service.setLinksEnabled(admin, { enabled: false });
    expect(await service.linksEnabled(member)).toBe(false);
    expect(await service.linksEnabled(outsider)).toBe(true);
    await expect(
      service.linksEnabled(run("agent_maker"))
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("no new link while the switch is off", async () => {
    await service.setLinksEnabled(admin, { enabled: false });
    await expect(
      service.createShare(owner, { artifactId: ARTIFACT })
    ).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("access log", () => {
  test("lists newest first, filters by link, pages, and never exposes the visitor hash", async () => {
    const a = await service.createShare(owner, { artifactId: ARTIFACT });
    const b = await service.createShare(owner, { artifactId: ARTIFACT });
    for (let i = 0; i < 30; i += 1) {
      advance(1000);
      // biome-ignore lint/performance/noAwaitInLoops: the calls run one after another on purpose
      await service.openLink(tokenOf(a.url), request());
    }
    for (let i = 0; i < 25; i += 1) {
      advance(1000);
      // biome-ignore lint/performance/noAwaitInLoops: the calls run one after another on purpose
      await service.openLink(tokenOf(b.url), request());
    }
    const first = await service.views(owner, { artifactId: ARTIFACT });
    expect(first.items).toHaveLength(50);
    expect(first.next).toBeDefined();
    expect(first.items.every((row) => !("visitorHash" in row))).toBe(true);
    const second = await service.views(owner, {
      artifactId: ARTIFACT,
      cursor: first.next,
    });
    expect(second.items).toHaveLength(5);
    expect(second.next).toBeUndefined();
    const onlyB = await service.views(admin, {
      artifactId: ARTIFACT,
      shareId: b.id,
    });
    expect(onlyB.items).toHaveLength(25);
    expect(onlyB.items.every((row) => row.shareId === b.id)).toBe(true);
    const ids = [...first.items, ...second.items].map((row) => row.id);
    expect(new Set(ids).size).toBe(55);
  });

  test("only the owner and admins read it", async () => {
    await expect(
      service.views(member, { artifactId: ARTIFACT })
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      service.views(member, { artifactId: OTHER_ARTIFACT })
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      service.views(run("agent_maker"), { artifactId: ARTIFACT })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("prune", () => {
  test("deletes views older than 365 days and salts older than 2 days (R1.33)", async () => {
    const share = await service.createShare(owner, { artifactId: ARTIFACT });
    await service.openLink(tokenOf(share.url), request());
    advance(364 * DAY);
    await service.openLink(tokenOf(share.url), request());
    advance(2 * DAY);
    await service.prune();
    const rows = db.select().from(artifactViews).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.createdAt).toBe(new Date(nowMs - 2 * DAY).toISOString());
    const salts = db.select().from(artifactViewSalts).all();
    expect(salts.map((s) => s.day)).toEqual(["2027-10-26"]);
  });
});

describe("secrets and addresses at rest (R1.13, R1.31)", () => {
  test("after every operation no table holds a view token, a share token or a full IP", async () => {
    const share = await service.createShare(owner, { artifactId: ARTIFACT });
    const token = tokenOf(share.url);
    const member1 = await service.open(member, {
      artifactId: ARTIFACT,
      surface: "viewer",
    });
    const linkOpen = await service.openLink(token, request());
    await service.openLink(token, request({ ip: IP6 }));
    const testRun = await service.mintTestToken(run("agent_maker"), {
      artifactId: ARTIFACT,
      versionId: "v2",
    });
    await service.revokeShare(owner, { shareId: share.id });
    await service.openLink(token, request());
    await service.setLinksEnabled(admin, { enabled: false });
    await service.setLinksEnabled(admin, { enabled: true });
    await service.prune();

    const dump = dumpDatabase();
    expect(dump).not.toContain(token);
    expect(dump).not.toContain("ag_share_");
    expect(dump).not.toContain(ARTIFACT_VIEW_TOKEN_PREFIX);
    expect(dump).not.toContain(IP);
    expect(dump).not.toContain(IP6);
    const urls = [
      member1.contentUrl,
      testRun.contentUrl,
      linkOpen.ok ? linkOpen.response.contentUrl : "",
    ];
    for (const url of urls) {
      const viewToken = viewTokenOf(url);
      expect(viewToken).toStartWith(ARTIFACT_VIEW_TOKEN_PREFIX);
      expect(dump).not.toContain(viewToken);
    }
  });
});

describe("types", () => {
  const grant: ShareGrant = {
    artifactId: ARTIFACT,
    kind: "share_grant",
    shareId: "s",
    versionId: "v",
    workspaceId: W1,
  };

  test("a ShareGrant cannot stand in for a Principal, and a Principal cannot stand in for a ShareGrant", () => {
    const takesPrincipal = (_principal: Principal) => undefined;
    const takesGrant = (_grant: ShareGrant) => undefined;
    const input = { artifactId: ARTIFACT, surface: "viewer" } as const;
    // @ts-expect-error a link grant is not a principal
    takesPrincipal(grant);
    // @ts-expect-error a principal is not a link grant
    takesGrant(owner);
    // @ts-expect-error the services take principals, never grants
    const opening = service.open(grant, input);
    expect(opening).toBeInstanceOf(Promise);
    return opening.then(
      () => {
        throw new Error("a grant must not open as a member");
      },
      (error: unknown) => {
        expect(error).toBeInstanceOf(ForbiddenError);
      }
    );
  });
});

test("a manager opens a proposed version, another member does not", async () => {
  db.insert(artifactVersions)
    .values({
      artifactId: ARTIFACT,
      authorId: "agent_maker",
      authorKind: "agent",
      createdAt: START,
      entry: "index.html",
      fileCount: 1,
      id: "v3",
      manifestKey: `${W1}/artifact-manifests/v3.json`,
      message: "m",
      number: 3,
      status: "proposed",
      totalBytes: 1,
      workspaceId: W1,
    })
    .run();
  const shares = build();
  const opened = await shares.open(owner, {
    artifactId: ARTIFACT,
    surface: "viewer",
    version: 3,
  });
  expect(opened.version.number).toBe(3);
  expect(opened.preview).toBe(true);
  const published = await shares.open(owner, {
    artifactId: ARTIFACT,
    surface: "viewer",
    version: 2,
  });
  expect(published.preview).toBeUndefined();
  const claims = await claimsOf(opened.contentUrl);
  expect(claims).toMatchObject({ versionId: "v3", viewer: "test" });
  expect(claims?.userId).toBeUndefined();
  await expect(
    shares.open(member, {
      artifactId: ARTIFACT,
      surface: "viewer",
      version: 3,
    })
  ).rejects.toThrow("Version not found");
});

test("a rejected version stays not found, even for a manager", async () => {
  db.insert(artifactVersions)
    .values({
      artifactId: ARTIFACT,
      authorId: "agent_maker",
      authorKind: "agent",
      createdAt: START,
      entry: "index.html",
      fileCount: 1,
      id: "v4",
      manifestKey: `${W1}/artifact-manifests/v4.json`,
      message: "m",
      number: 4,
      status: "rejected",
      totalBytes: 1,
      workspaceId: W1,
    })
    .run();
  await expect(
    build().open(owner, { artifactId: ARTIFACT, surface: "viewer", version: 4 })
  ).rejects.toThrow("Version not found");
});
