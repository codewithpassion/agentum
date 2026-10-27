// Live links (B.6): creating them (R2.10) and the call-time checks of a
// viewer's tool call (R2.6, R2.11 to R2.14).
import { beforeEach, describe, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import {
  artifactGrants,
  artifacts,
  artifactVersions,
  artifactViews,
} from "@repo/db/schema/artifacts";
import { events as eventRows } from "@repo/db/schema/events";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { ForbiddenError } from "../authz.ts";
import { ServiceError } from "../errors.ts";
import { createEventsService } from "../events.ts";
import type { Principal } from "../workspaces.ts";
import { ArtifactCallError, type ToolRunInput } from "./calls.ts";
import {
  type ArtifactSharesService,
  createArtifactSharesService,
  type LinkCallResult,
  type ShareRequestInfo,
} from "./shares.ts";

const W1 = "w1";
const START = "2026-10-27T10:00:00.000Z";
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ORIGIN = "https://hm.test";
const ARTIFACT = crypto.randomUUID();
const LIST = "xero/list_invoices";
const GET = "xero/get_invoice";
const NEW_TOOL = "xero/list_contacts";
const LIMITED = `${LIST}#{"limit":{"max":5}}`;

const user = (userId: string, isAdmin = false): Principal => ({
  isAdmin,
  kind: "user",
  userId,
  via: "session",
  workspaceId: W1,
});
const owner = user("u_owner");
const admin = user("u_admin", true);

const request = (ip: string | null = "203.0.113.7"): ShareRequestInfo => ({
  cf: { country: "AU" },
  ip,
  referrer: null,
  userAgent: "Mozilla/5.0",
});

let db: ReturnType<typeof migrated>;
let nowMs: number;
let service: ArtifactSharesService;
let runs: ToolRunInput[];
let runError: Error | null;
let memberAnswer: boolean;
let memberCalls: [string, string][];
let memberThrows: boolean;
let allowedOrgs: string[];
let withRunner: boolean;
let storeCalls: {
  area: string;
  artifactId: string;
  op: string;
  prefix?: string;
  viewerKey: string;
}[];
let stored: Map<string, string>;
let withStore: boolean;

const build = () => {
  const store = new Map<string, string>();
  return createArtifactSharesService({
    allowedOrgIds: allowedOrgs,
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
    isOrgMember: (userId, orgId) => {
      memberCalls.push([userId, orgId]);
      return memberThrows
        ? Promise.reject(new Error("Clerk is down"))
        : Promise.resolve(memberAnswer);
    },
    origin: ORIGIN,
    runner: withRunner
      ? {
          run: (input) => {
            runs.push(input);
            return runError
              ? Promise.reject(runError)
              : Promise.resolve({ result: { content: [{ text: "42" }] } });
          },
        }
      : undefined,
    secretsKey: btoa(
      String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))
    ),
    store: withStore
      ? {
          get: (scope, key) => {
            storeCalls.push({ ...scope, op: "get" });
            return Promise.resolve(stored.get(key) ?? null);
          },
          list: (scope, prefix) => {
            storeCalls.push({ ...scope, op: "list", prefix });
            return Promise.resolve(
              [...stored]
                .filter(([key]) => key.startsWith(prefix))
                .map(([key, value]) => ({ key, value }))
            );
          },
        }
      : undefined,
    viewKey: "test-view-key",
  });
};

const seedVersion = (id: string, number: number) =>
  db
    .insert(artifactVersions)
    .values({
      artifactId: ARTIFACT,
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

const grant = (versionId: string, target: string, status = "approved") =>
  db
    .insert(artifactGrants)
    .values({
      createdAt: START,
      id: crypto.randomUUID(),
      kind: "tool",
      status: status as "approved",
      target,
      versionId,
      workspaceId: W1,
    })
    .run();

const setCurrent = (versionId: string) =>
  db
    .update(artifacts)
    .set({ currentVersionId: versionId })
    .where(eq(artifacts.id, ARTIFACT))
    .run();

beforeEach(() => {
  db = migrated();
  nowMs = Date.parse(START);
  runs = [];
  runError = null;
  memberAnswer = true;
  memberCalls = [];
  memberThrows = false;
  allowedOrgs = ["org_w1"];
  withRunner = true;
  withStore = true;
  storeCalls = [];
  stored = new Map([
    ["stats", '{"total":3}'],
    ["note", "plain words"],
    ["stats/old", "1"],
  ]);
  db.insert(workspaces)
    .values({
      clerkOrgId: "org_w1",
      createdAt: START,
      id: W1,
      name: "Workspace",
      timezone: "UTC",
    })
    .run();
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
  db.insert(artifacts)
    .values({
      agentId: "agent_maker",
      audience: "workspace",
      createdAt: START,
      createdById: "u_owner",
      createdByKind: "user",
      id: ARTIFACT,
      kind: "dashboard",
      ownerUserId: "u_owner",
      title: "Invoices",
      updatedAt: START,
      workspaceId: W1,
    })
    .run();
  seedVersion("v1", 1);
  seedVersion("v2", 2);
  setCurrent("v2");
  // v1 approved two tools, v2 approved one of them and a limits row.
  grant("v1", LIST);
  grant("v1", GET);
  grant("v2", LIST);
  grant("v2", LIMITED);
  grant("v2", NEW_TOOL, "pending");
  service = build();
});

const liveLink = async (
  options: { expiresAt?: string; liveTools?: string[]; versionId?: string } = {}
) => {
  const share = await service.createShare(owner, {
    artifactId: ARTIFACT,
    dataMode: "live",
    liveTools: [LIST],
    ...options,
  });
  return { id: share.id, token: share.url.slice(`${ORIGIN}/s/`.length) };
};

const viewsOf = (shareId: string) =>
  db
    .select()
    .from(artifactViews)
    .where(eq(artifactViews.shareId, shareId))
    .all()
    .filter((row) => row.surface === "live_call");

describe("creating a live link (R2.10)", () => {
  test("the owner creates one that records granted_by and the tools", async () => {
    const share = await service.createShare(owner, {
      artifactId: ARTIFACT,
      dataMode: "live",
      liveTools: [LIST, LIST],
    });
    expect(share).toMatchObject({
      dataMode: "live",
      grantedBy: "u_owner",
      liveTools: [LIST],
    });
    const event = db
      .select()
      .from(eventRows)
      .where(eq(eventRows.type, "artifact.share_created"))
      .get();
    expect(event?.payload ?? "").not.toContain("hm_share_");
  });

  test("a snapshot link records no granter and no tools", async () => {
    const share = await service.createShare(owner, { artifactId: ARTIFACT });
    expect(share).toMatchObject({
      dataMode: "snapshot",
      grantedBy: null,
      liveTools: null,
    });
  });

  test("an admin who is not the owner makes snapshot links only", async () => {
    await expect(
      service.createShare(admin, {
        artifactId: ARTIFACT,
        dataMode: "live",
        liveTools: [LIST],
      })
    ).rejects.toBeInstanceOf(ForbiddenError);
    await service.createShare(admin, { artifactId: ARTIFACT });
  });

  test("tools outside the version's approved grants are refused", async () => {
    for (const tool of [NEW_TOOL, GET, "xero/unknown", LIMITED]) {
      // biome-ignore lint/performance/noAwaitInLoops: each tool is checked in turn
      await expect(
        service.createShare(owner, {
          artifactId: ARTIFACT,
          dataMode: "live",
          liveTools: [tool],
        })
      ).rejects.toBeInstanceOf(ServiceError);
    }
  });

  test("a pinned link takes its tools from the pinned version", async () => {
    const share = await service.createShare(owner, {
      artifactId: ARTIFACT,
      dataMode: "live",
      liveTools: [GET],
      versionId: "v1",
    });
    expect(share.liveTools).toEqual([GET]);
    await expect(
      service.createShare(owner, {
        artifactId: ARTIFACT,
        dataMode: "live",
        liveTools: [GET],
      })
    ).rejects.toBeInstanceOf(ServiceError);
  });
});

describe("a live call", () => {
  test("runs the tool as granted_by and writes one live_call row (R2.14)", async () => {
    const link = await liveLink();
    const answer = await service.callLink(
      link.token,
      { arguments: { month: "2026-09" }, tool: LIST },
      request()
    );
    expect(answer).toEqual({
      ok: true,
      result: { content: [{ text: "42" }] },
    });
    expect(runs).toEqual([
      {
        agentId: "agent_maker",
        arguments: { month: "2026-09" },
        toolKey: LIST,
        userId: "u_owner",
        workspaceId: W1,
      },
    ]);
    const rows = viewsOf(link.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      artifactId: ARTIFACT,
      country: "AU",
      ipPrefix: "203.0.113.0/24",
      outcome: "ok",
      toolKey: LIST,
      versionId: "v2",
    });
    expect(rows[0]?.visitorHash).not.toBeNull();
  });

  test("a snapshot link refuses every call (R2.6)", async () => {
    const snapshot = await service.createShare(owner, {
      artifactId: ARTIFACT,
    });
    const token = snapshot.url.slice(`${ORIGIN}/s/`.length);
    expect(await service.callLink(token, { tool: LIST }, request())).toEqual({
      ok: false,
      reason: "forbidden",
    });
    expect(runs).toHaveLength(0);
    expect(viewsOf(snapshot.id)[0]).toMatchObject({
      outcome: "refused",
      toolKey: LIST,
    });
  });

  test("a tool outside live_tools is refused even when the version grants it", async () => {
    const link = await liveLink({ liveTools: [LIST] });
    grant("v2", GET);
    const answer = await service.callLink(link.token, { tool: GET }, request());
    expect(answer).toEqual({ ok: false, reason: "forbidden" });
    expect(runs).toHaveLength(0);
  });

  test("a later version that drops the grant stops the next call, and one that adds tools widens nothing", async () => {
    const link = await liveLink();
    db.delete(artifactGrants).where(eq(artifactGrants.versionId, "v2")).run();
    expect(
      await service.callLink(link.token, { tool: LIST }, request())
    ).toEqual({ ok: false, reason: "forbidden" });
    grant("v2", NEW_TOOL);
    expect(
      await service.callLink(link.token, { tool: NEW_TOOL }, request())
    ).toEqual({ ok: false, reason: "forbidden" });
    expect(runs).toHaveLength(0);
  });

  test("a grant a person revoked stops the next call", async () => {
    const link = await liveLink();
    db.update(artifactGrants)
      .set({ status: "rejected" })
      .where(eq(artifactGrants.versionId, "v2"))
      .run();
    expect(
      await service.callLink(link.token, { tool: LIST }, request())
    ).toEqual({ ok: false, reason: "forbidden" });
  });

  test("a pinned link checks the pinned version's grants", async () => {
    const link = await liveLink({ liveTools: [GET], versionId: "v1" });
    expect(
      (await service.callLink(link.token, { tool: GET }, request())).ok
    ).toBe(true);
    expect(viewsOf(link.id)[0]?.versionId).toBe("v1");
  });

  test("an unknown token reads as not found and writes nothing", async () => {
    expect(
      await service.callLink("hm_share_unknown", { tool: LIST }, request())
    ).toEqual({ ok: false, reason: "not_found" });
    expect(await service.callLink("nope", { tool: LIST }, request())).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(db.select().from(artifactViews).all()).toHaveLength(0);
  });

  test("an unreadable call is refused before it touches anything", async () => {
    const link = await liveLink();
    await expect(
      service.callLink(link.token, { tool: "" }, request())
    ).rejects.toThrow();
  });
});

describe("dead links (R2.12)", () => {
  test("a revoked link refuses the next call with no cache in between", async () => {
    const link = await liveLink();
    expect(
      (await service.callLink(link.token, { tool: LIST }, request())).ok
    ).toBe(true);
    await service.revokeShare(owner, { shareId: link.id });
    expect(
      await service.callLink(link.token, { tool: LIST }, request())
    ).toEqual({ ok: false, reason: "not_found" });
    expect(runs).toHaveLength(1);
    expect(viewsOf(link.id).map((row) => row.outcome)).toEqual([
      "ok",
      "revoked",
    ]);
  });

  test("an expired link refuses", async () => {
    const link = await liveLink({
      expiresAt: new Date(nowMs + HOUR).toISOString(),
    });
    nowMs += 2 * HOUR;
    expect(
      await service.callLink(link.token, { tool: LIST }, request())
    ).toEqual({ ok: false, reason: "not_found" });
    expect(viewsOf(link.id)[0]?.outcome).toBe("expired");
  });

  test("the workspace switch and ARTIFACT_LINKS_OFF refuse", async () => {
    const link = await liveLink();
    await service.setLinksEnabled(admin, { enabled: false });
    expect(
      await service.callLink(link.token, { tool: LIST }, request())
    ).toEqual({ ok: false, reason: "not_found" });
    expect(viewsOf(link.id)[0]?.outcome).toBe("disabled");
  });

  test("a deleted artifact refuses", async () => {
    const link = await liveLink();
    db.update(artifacts)
      .set({ deletedAt: START })
      .where(eq(artifacts.id, ARTIFACT))
      .run();
    expect(
      await service.callLink(link.token, { tool: LIST }, request())
    ).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("the granter (R2.11)", () => {
  test("membership is asked on every call", async () => {
    const link = await liveLink();
    await service.callLink(link.token, { tool: LIST }, request());
    await service.callLink(link.token, { tool: LIST }, request());
    expect(memberCalls).toEqual([
      ["u_owner", "org_w1"],
      ["u_owner", "org_w1"],
    ]);
  });

  test("an owner who left the org stops the next call", async () => {
    const link = await liveLink();
    expect(
      (await service.callLink(link.token, { tool: LIST }, request())).ok
    ).toBe(true);
    memberAnswer = false;
    expect(
      await service.callLink(link.token, { tool: LIST }, request())
    ).toEqual({ ok: false, reason: "forbidden" });
    expect(runs).toHaveLength(1);
    expect(viewsOf(link.id)[1]?.outcome).toBe("refused");
  });

  test("a granter who no longer owns the artifact is refused", async () => {
    const link = await liveLink();
    db.update(artifacts)
      .set({ ownerUserId: "u_new_owner" })
      .where(eq(artifacts.id, ARTIFACT))
      .run();
    expect(
      await service.callLink(link.token, { tool: LIST }, request())
    ).toEqual({ ok: false, reason: "forbidden" });
    expect(memberCalls).toHaveLength(0);
  });

  test("a workspace whose org is no longer allowed is refused", async () => {
    const link = await liveLink();
    allowedOrgs = [];
    service = build();
    expect(
      await service.callLink(link.token, { tool: LIST }, request())
    ).toEqual({ ok: false, reason: "forbidden" });
  });

  test("without a membership check or a runner nothing runs", async () => {
    const link = await liveLink();
    withRunner = false;
    service = build();
    expect(
      await service.callLink(link.token, { tool: LIST }, request())
    ).toEqual({ ok: false, reason: "forbidden" });
  });

  test("a failing membership lookup fails closed and logs an error row", async () => {
    const link = await liveLink();
    memberThrows = true;
    const original = console.error;
    console.error = () => undefined;
    try {
      expect(
        await service.callLink(link.token, { tool: LIST }, request())
      ).toEqual({ ok: false, reason: "failed" });
    } finally {
      console.error = original;
    }
    expect(runs).toHaveLength(0);
    expect(viewsOf(link.id)[0]?.outcome).toBe("error");
  });
});

/** `count` calls in turn, each from the IP `ipOf` gives. */
const callInTurn = async (
  token: string,
  count: number,
  ipOf: (index: number) => string | null = () => "203.0.113.7"
) => {
  const answers: LinkCallResult[] = [];
  for (let index = 0; index < count; index += 1) {
    answers.push(
      // biome-ignore lint/performance/noAwaitInLoops: the calls must land one after another
      await service.callLink(token, { tool: LIST }, request(ipOf(index)))
    );
  }
  return answers;
};

describe("rate limits (R2.13)", () => {
  test("a visitor gets 10 calls a minute, then rate_limited, and recovers", async () => {
    const link = await liveLink();
    expect((await callInTurn(link.token, 10)).every(({ ok }) => ok)).toBe(true);
    expect(
      await service.callLink(link.token, { tool: LIST }, request())
    ).toEqual({ ok: false, reason: "rate_limited" });
    expect(runs).toHaveLength(10);
    // Another visitor is not affected.
    expect(
      (
        await service.callLink(
          link.token,
          { tool: LIST },
          request("198.51.100.9")
        )
      ).ok
    ).toBe(true);
    nowMs += MINUTE + 1;
    expect(
      (await service.callLink(link.token, { tool: LIST }, request())).ok
    ).toBe(true);
    const outcomes = viewsOf(link.id).map((row) => row.outcome);
    expect(
      outcomes.filter((outcome) => outcome === "rate_limited")
    ).toHaveLength(1);
  });

  test("a link gets 60 calls a minute across visitors", async () => {
    const link = await liveLink();
    const answers = await callInTurn(
      link.token,
      60,
      (index) => `198.51.${index}.1`
    );
    expect(answers.every(({ ok }) => ok)).toBe(true);
    expect(
      await service.callLink(link.token, { tool: LIST }, request("192.0.2.1"))
    ).toEqual({ ok: false, reason: "rate_limited" });
    nowMs += MINUTE + 1;
    expect(
      (await service.callLink(link.token, { tool: LIST }, request("192.0.2.1")))
        .ok
    ).toBe(true);
  });

  test("a link gets 1,000 calls a day", async () => {
    const link = await liveLink();
    const rows = Array.from({ length: 1000 }, (_, index) => ({
      artifactId: ARTIFACT,
      createdAt: new Date(nowMs - HOUR - index * 1000).toISOString(),
      id: `old${index}`,
      outcome: "ok" as const,
      shareId: link.id,
      surface: "live_call" as const,
      toolKey: LIST,
      visitorHash: `v${index % 200}`,
      workspaceId: W1,
    }));
    for (let start = 0; start < rows.length; start += 100) {
      db.insert(artifactViews)
        .values(rows.slice(start, start + 100))
        .run();
    }
    expect(
      await service.callLink(link.token, { tool: LIST }, request())
    ).toEqual({ ok: false, reason: "rate_limited" });
    nowMs += DAY;
    expect(
      (await service.callLink(link.token, { tool: LIST }, request())).ok
    ).toBe(true);
  });

  test("rate limited rows do not count, and a visitor with no IP shares one bucket", async () => {
    const link = await liveLink();
    await callInTurn(link.token, 10, () => null);
    const refused = await callInTurn(link.token, 5, () => null);
    expect(refused).toEqual(
      Array.from({ length: 5 }, () => ({ ok: false, reason: "rate_limited" }))
    );
    nowMs += MINUTE + 1;
    expect(
      (await service.callLink(link.token, { tool: LIST }, request(null))).ok
    ).toBe(true);
  });
});

describe("outcomes of the run (R2.14)", () => {
  test("a refusal by the runner is a 403 with outcome refused", async () => {
    const link = await liveLink();
    runError = new ArtifactCallError("not_granted", "no");
    expect(
      await service.callLink(link.token, { tool: LIST }, request())
    ).toEqual({ ok: false, reason: "forbidden" });
    const rows = viewsOf(link.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("refused");
  });

  for (const code of ["failed", "needs_auth", "too_large"] as const) {
    test(`${code} is a failed call with outcome error`, async () => {
      const link = await liveLink();
      runError = new ArtifactCallError(code, "secret detail of the owner");
      const original = console.error;
      console.error = () => undefined;
      try {
        expect(
          await service.callLink(link.token, { tool: LIST }, request())
        ).toEqual({ ok: false, reason: "failed" });
      } finally {
        console.error = original;
      }
      const rows = viewsOf(link.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.outcome).toBe("error");
    });
  }

  test("no row stores a token", async () => {
    const link = await liveLink();
    await service.callLink(link.token, { tool: LIST }, request());
    expect(JSON.stringify(db.select().from(artifactViews).all())).not.toContain(
      link.token
    );
  });
});

describe("storage reads by link (B.6 addition)", () => {
  test("get returns the parsed value, the raw text of an app's plain write, or null", async () => {
    const link = await liveLink();
    const read = (key: string) =>
      service.storageLink(link.token, { key, op: "get" });
    expect(await read("stats")).toEqual({
      ok: true,
      result: { value: { total: 3 } },
    });
    expect(await read("note")).toEqual({
      ok: true,
      result: { value: "plain words" },
    });
    expect(await read("missing")).toEqual({
      ok: true,
      result: { value: null },
    });
  });

  test("every read targets the shared area of the link's artifact", async () => {
    const link = await liveLink();
    await service.storageLink(link.token, { key: "stats", op: "get" });
    await service.storageLink(link.token, { op: "list", prefix: "stats" });
    expect(storeCalls).toEqual([
      {
        area: "shared",
        artifactId: ARTIFACT,
        op: "get",
        viewerKey: `l:${link.id}`,
      },
      {
        area: "shared",
        artifactId: ARTIFACT,
        op: "list",
        prefix: "stats",
        viewerKey: `l:${link.id}`,
      },
    ]);
  });

  test("list returns the keys under a prefix", async () => {
    const link = await liveLink();
    expect(
      await service.storageLink(link.token, { op: "list", prefix: "stats" })
    ).toEqual({ ok: true, result: { keys: ["stats", "stats/old"] } });
  });

  test("a snapshot link reads too", async () => {
    const snapshot = await service.createShare(owner, {
      artifactId: ARTIFACT,
    });
    const token = snapshot.url.slice(`${ORIGIN}/s/`.length);
    expect((await service.storageLink(token, { op: "list" })).ok).toBe(true);
  });

  test("writes are always forbidden and reach no store, on live and snapshot links", async () => {
    const live = await liveLink();
    const snapshot = await service.createShare(owner, {
      artifactId: ARTIFACT,
    });
    for (const token of [
      live.token,
      snapshot.url.slice(`${ORIGIN}/s/`.length),
    ]) {
      for (const op of ["set", "delete"] as const) {
        expect(
          // biome-ignore lint/performance/noAwaitInLoops: each write is its own step
          await service.storageLink(token, { key: "stats", op })
        ).toEqual({ ok: false, reason: "forbidden" });
      }
    }
    expect(storeCalls).toHaveLength(0);
  });

  test("a revoked, expired or disabled link is not found, writes included", async () => {
    const revoked = await liveLink();
    await service.revokeShare(owner, { shareId: revoked.id });
    expect(
      await service.storageLink(revoked.token, { key: "stats", op: "set" })
    ).toEqual({ ok: false, reason: "not_found" });
    expect(await service.storageLink(revoked.token, { op: "list" })).toEqual({
      ok: false,
      reason: "not_found",
    });
    const expiring = await liveLink({
      expiresAt: new Date(nowMs + HOUR).toISOString(),
    });
    nowMs += 2 * HOUR;
    expect(await service.storageLink(expiring.token, { op: "list" })).toEqual({
      ok: false,
      reason: "not_found",
    });
    const other = await liveLink();
    await service.setLinksEnabled(admin, { enabled: false });
    expect(await service.storageLink(other.token, { op: "list" })).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(storeCalls).toHaveLength(0);
  });

  test("an unknown token is not found, and a missing store fails", async () => {
    expect(
      await service.storageLink("hm_share_unknown", { op: "list" })
    ).toEqual({ ok: false, reason: "not_found" });
    const link = await liveLink();
    withStore = false;
    service = build();
    expect(await service.storageLink(link.token, { op: "list" })).toEqual({
      ok: false,
      reason: "failed",
    });
  });
});
