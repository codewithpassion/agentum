import { beforeEach, describe, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import {
  managedAgents,
  managedSessions,
  workspaceAnthropicKeys,
} from "@repo/db/schema/managed";
import { sessions } from "@repo/db/schema/sessions";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { ForbiddenError } from "../authz.ts";
import { ServiceError } from "../errors.ts";
import type { Clock } from "../runs/types.ts";
import type { Principal } from "../workspaces.ts";
import { createManagedKeysService } from "./keys.ts";

const WORKSPACE = "w1";
const OTHER_WORKSPACE = "w2";
const START = "2026-10-16T10:00:00.000Z";
const KEY = "sk-ant-test-0000";
const ROTATED_KEY = "sk-ant-test-9999";
const SECRETS_KEY = Buffer.from(
  crypto.getRandomValues(new Uint8Array(32))
).toString("base64");

const user: Principal = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: WORKSPACE,
};
const otherWorkspaceUser: Principal = {
  kind: "user",
  userId: "u2",
  via: "session",
  workspaceId: OTHER_WORKSPACE,
};
const run: Principal = {
  agentId: "ag_run",
  kind: "run",
  runId: "run_1",
  workspaceId: WORKSPACE,
};
const machine: Principal = {
  kind: "machine",
  machineId: "m1",
  workspaceId: WORKSPACE,
};
const system: Principal = { kind: "system" };

let db: ReturnType<typeof migrated>;
let nowMs: number;
let clock: Clock;

const seedWorkspace = (id: string) =>
  db
    .insert(workspaces)
    .values({
      clerkOrgId: `org_${id}`,
      createdAt: START,
      id,
      name: id,
      timezone: "UTC",
    })
    .run();

/** One agent, one session and the Anthropic ids made for them, in a workspace. */
const seedAnthropicIds = (workspaceId: string, tag: string) => {
  const agentId = `ag_${tag}`;
  db.insert(agents)
    .values({
      createdAt: START,
      createdBy: "u1",
      id: agentId,
      instructions: "",
      model: "claude-test",
      name: tag,
      runtime: "managed",
      runtimeConfig: "{}",
      slug: tag,
      status: "active",
      workspaceId,
    })
    .run();
  db.insert(sessions)
    .values({
      actorId: "u1",
      actorKind: "user",
      agentId,
      createdAt: START,
      id: `ses_${tag}`,
      origin: "ui",
      workspaceId,
    })
    .run();
  db.insert(managedSessions)
    .values({
      agentFingerprint: "fp",
      anthropicSessionId: `sesn_${tag}`,
      createdAt: START,
      sessionId: `ses_${tag}`,
      tokenIssuedAt: 1,
      vaultId: `vlt_${tag}`,
      workspaceId,
    })
    .run();
  db.insert(managedAgents)
    .values({
      agentId,
      anthropicAgentId: `agt_${tag}`,
      createdAt: START,
      fingerprint: "fp",
      syncedAt: START,
      workspaceId,
    })
    .run();
};

const anthropicIdCounts = (workspaceId: string) => ({
  agents: db
    .select()
    .from(managedAgents)
    .where(eq(managedAgents.workspaceId, workspaceId))
    .all().length,
  sessions: db
    .select()
    .from(managedSessions)
    .where(eq(managedSessions.workspaceId, workspaceId))
    .all().length,
});

const rowOf = (workspaceId: string) =>
  db
    .select()
    .from(workspaceAnthropicKeys)
    .where(eq(workspaceAnthropicKeys.workspaceId, workspaceId))
    .get();

const build = (validate?: (apiKey: string) => Promise<boolean>) =>
  createManagedKeysService({
    atomic: sqliteAtomic(db),
    clock,
    db,
    secretsKey: SECRETS_KEY,
    validate,
  });

beforeEach(() => {
  db = migrated();
  nowMs = Date.parse(START);
  clock = {
    now: () => new Date(nowMs),
    sleep: () => Promise.resolve(),
  };
  seedWorkspace(WORKSPACE);
  seedWorkspace(OTHER_WORKSPACE);
});

describe("set and status", () => {
  test("reports configured with the last four characters, never the key", async () => {
    const service = build();

    const status = await service.set(user, { apiKey: KEY });

    expect(status).toEqual({
      configured: true,
      hint: "0000",
      updatedAt: START,
    });
    expect(JSON.stringify(await service.status(user))).not.toContain(KEY);
    expect(await service.status(user)).toEqual(status);
  });

  test("trims the key before it is checked and hinted", async () => {
    const service = build();

    const status = await service.set(user, { apiKey: `  ${KEY}\n` });

    expect(status.hint).toBe("0000");
    expect((await service.resolve(WORKSPACE))?.apiKey).toBe(KEY);
  });

  test("stores the key encrypted, bound to its workspace", async () => {
    const service = build();
    await service.set(user, { apiKey: KEY });
    await service.set(otherWorkspaceUser, { apiKey: ROTATED_KEY });

    const stored = rowOf(WORKSPACE)?.apiKeyEnc ?? "";
    expect(stored).not.toBe("");
    expect(stored).not.toContain(KEY);

    // Copy this workspace's ciphertext into the other workspace's row.
    db.update(workspaceAnthropicKeys)
      .set({ apiKeyEnc: stored })
      .where(eq(workspaceAnthropicKeys.workspaceId, OTHER_WORKSPACE))
      .run();

    await expect(service.resolve(OTHER_WORKSPACE)).rejects.toThrow();
    expect((await service.resolve(WORKSPACE))?.apiKey).toBe(KEY);
  });

  test("refuses a key with the wrong prefix, without echoing it", async () => {
    const service = build();
    const wrong = "sk-openai-test-0000";

    const error = await service.set(user, { apiKey: wrong }).catch((e) => e);

    expect(error).toBeInstanceOf(ServiceError);
    expect(error.code).toBe("invalid");
    expect(error.message).not.toContain(wrong);
    expect(rowOf(WORKSPACE)).toBeUndefined();
  });

  test("refuses an over-long key, without echoing it", async () => {
    const service = build();
    const long = `sk-ant-${"x".repeat(600)}`;

    const error = await service.set(user, { apiKey: long }).catch((e) => e);

    expect(error).toBeInstanceOf(ServiceError);
    expect(error.message).not.toContain("xxxx");
    expect(rowOf(WORKSPACE)).toBeUndefined();
  });

  test("refuses a key the live check rejects, and stores nothing", async () => {
    const service = build(async () => false);

    const error = await service.set(user, { apiKey: KEY }).catch((e) => e);

    expect(error).toBeInstanceOf(ServiceError);
    expect(error.code).toBe("invalid");
    expect(error.message).toBe("Anthropic did not accept that key");
    expect(rowOf(WORKSPACE)).toBeUndefined();
  });

  test("a live check that throws is a refusal that does not echo the key", async () => {
    const service = build((apiKey) =>
      Promise.reject(new Error(`request failed for ${apiKey}`))
    );

    const error = await service.set(user, { apiKey: KEY }).catch((e) => e);

    expect(error).toBeInstanceOf(ServiceError);
    expect(error.message).not.toContain(KEY);
    expect(rowOf(WORKSPACE)).toBeUndefined();
  });

  test("without a live check, only the shape is checked", async () => {
    const service = build();

    expect((await service.set(user, { apiKey: KEY })).configured).toBe(true);
  });

  test("throws a plain Error when secretsKey is missing", async () => {
    const service = createManagedKeysService({
      atomic: sqliteAtomic(db),
      clock,
      db,
    });

    const error = await service.set(user, { apiKey: KEY }).catch((e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ServiceError);
    expect(error.message).not.toContain(KEY);
    expect(rowOf(WORKSPACE)).toBeUndefined();
  });
});

describe("rotation", () => {
  test("resets the environment and clears this workspace's Anthropic ids only", async () => {
    const service = build();
    await service.set(user, { apiKey: KEY });
    await service.rememberEnvironment(WORKSPACE, "env_1");
    seedAnthropicIds(WORKSPACE, "mine");
    seedAnthropicIds(OTHER_WORKSPACE, "theirs");
    const createdAt = rowOf(WORKSPACE)?.createdAt;

    nowMs += 60_000;
    const status = await service.set(user, { apiKey: ROTATED_KEY });

    expect(status.hint).toBe("9999");
    expect(status.updatedAt).toBe(new Date(nowMs).toISOString());
    expect(rowOf(WORKSPACE)?.environmentId).toBeNull();
    expect(rowOf(WORKSPACE)?.createdAt).toBe(createdAt ?? "");
    expect(rowOf(WORKSPACE)?.setBy).toBe(user.userId);
    expect(anthropicIdCounts(WORKSPACE)).toEqual({ agents: 0, sessions: 0 });
    expect(anthropicIdCounts(OTHER_WORKSPACE)).toEqual({
      agents: 1,
      sessions: 1,
    });
    expect((await service.resolve(WORKSPACE))?.apiKey).toBe(ROTATED_KEY);
  });
});

describe("remove", () => {
  test("deletes the row and the same Anthropic ids, and is idempotent", async () => {
    const service = build();
    await service.set(user, { apiKey: KEY });
    seedAnthropicIds(WORKSPACE, "mine");
    seedAnthropicIds(OTHER_WORKSPACE, "theirs");

    const first = await service.remove(user);
    const second = await service.remove(user);

    const notConfigured = { configured: false, hint: null, updatedAt: null };
    expect(first).toEqual(notConfigured);
    expect(second).toEqual(notConfigured);
    expect(rowOf(WORKSPACE)).toBeUndefined();
    expect(anthropicIdCounts(WORKSPACE)).toEqual({ agents: 0, sessions: 0 });
    expect(anthropicIdCounts(OTHER_WORKSPACE)).toEqual({
      agents: 1,
      sessions: 1,
    });
  });
});

describe("resolve and rememberEnvironment", () => {
  test("resolve is null when the workspace has no key", async () => {
    expect(await build().resolve(WORKSPACE)).toBeNull();
  });

  test("resolve returns the key and the remembered environment", async () => {
    const service = build();
    await service.set(user, { apiKey: KEY });

    await service.rememberEnvironment(WORKSPACE, "env_1");

    expect(await service.resolve(WORKSPACE)).toEqual({
      apiKey: KEY,
      environmentId: "env_1",
    });
  });

  test("rememberEnvironment does nothing without a key row", async () => {
    await build().rememberEnvironment(WORKSPACE, "env_1");

    expect(rowOf(WORKSPACE)).toBeUndefined();
  });

  test("resolve throws a plain Error when secretsKey is missing", async () => {
    await build().set(user, { apiKey: KEY });
    const service = createManagedKeysService({
      atomic: sqliteAtomic(db),
      clock,
      db,
    });

    const error = await service.resolve(WORKSPACE).catch((e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ServiceError);
  });
});

describe("authorization", () => {
  test("a principal of another workspace sees its own status, not this one", async () => {
    const service = build();
    await service.set(user, { apiKey: KEY });

    expect((await service.status(otherWorkspaceUser)).configured).toBe(false);
    expect((await service.status(user)).configured).toBe(true);
  });

  test("the system principal may not read the status", async () => {
    await expect(build().status(system)).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("a run or machine principal cannot set or remove the key", async () => {
    const service = build();
    await service.set(user, { apiKey: KEY });

    await Promise.all(
      [run, machine].flatMap((principal) => [
        expect(
          service.set(principal, { apiKey: ROTATED_KEY })
        ).rejects.toBeInstanceOf(ForbiddenError),
        expect(service.remove(principal)).rejects.toBeInstanceOf(
          ForbiddenError
        ),
      ])
    );
    expect((await service.resolve(WORKSPACE))?.apiKey).toBe(KEY);
  });
});
