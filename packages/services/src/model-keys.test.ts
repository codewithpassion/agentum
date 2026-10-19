import { beforeEach, describe, expect, test } from "bun:test";
import { agents } from "@repo/db/schema/agents";
import {
  managedAgents,
  managedSessions,
  managedSkills,
  managedSkillVersions,
  workspaceAnthropicKeys,
} from "@repo/db/schema/managed";
import { workspaceModelKeys } from "@repo/db/schema/model-keys";
import { sessions } from "@repo/db/schema/sessions";
import { workspaces } from "@repo/db/schema/workspaces";
import type { ModelProvider } from "@repo/db/shared";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { ForbiddenError } from "./authz.ts";
import {
  decryptSecret,
  importSecretsKey,
  type SecretBinding,
} from "./crypto.ts";
import { ServiceError } from "./errors.ts";
import {
  createModelKeysService,
  NO_KEY_MESSAGES,
  validateOpenRouterKey,
} from "./model-keys.ts";
import type { Clock } from "./runs/types.ts";
import type { Principal } from "./workspaces.ts";

const WORKSPACE = "w1";
const OTHER_WORKSPACE = "w2";
const START = "2026-10-16T10:00:00.000Z";
const KEY = "sk-or-test-abcd1234";
const ROTATED_KEY = "sk-or-test-wxyz9876";
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

const NOT_CONFIGURED = { configured: false, hint: null, updatedAt: null };

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
  db.insert(managedSkills)
    .values({
      agentId,
      anthropicSkillId: `skill_${tag}`,
      anthropicVersion: "1",
      contentHash: "hash",
      createdAt: START,
      name: `skill-${tag}`,
      syncedAt: START,
      workspaceId,
    })
    .run();
  db.insert(managedSkillVersions)
    .values({
      anthropicSkillId: `skill_${tag}`,
      anthropicVersion: "1",
      createdAt: START,
      skillId: `hm_${tag}`,
      version: 1,
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
  skills: db
    .select()
    .from(managedSkills)
    .where(eq(managedSkills.workspaceId, workspaceId))
    .all().length,
  skillVersions: db
    .select()
    .from(managedSkillVersions)
    .where(eq(managedSkillVersions.workspaceId, workspaceId))
    .all().length,
});

const modelKeyRow = (workspaceId: string) =>
  db
    .select()
    .from(workspaceModelKeys)
    .where(eq(workspaceModelKeys.workspaceId, workspaceId))
    .get();

const anthropicKeyRow = (workspaceId: string) =>
  db
    .select()
    .from(workspaceAnthropicKeys)
    .where(eq(workspaceAnthropicKeys.workspaceId, workspaceId))
    .get();

const bindingFor = (workspaceId: string, rowId: string): SecretBinding => ({
  field: "api_key",
  rowId,
  table: "workspace_model_keys",
  workspaceId,
});

/** The rejection of an attempt. Fails the test when the attempt succeeds. */
const refusalOf = async (attempt: Promise<unknown>): Promise<unknown> => {
  try {
    await attempt;
  } catch (error) {
    return error;
  }
  throw new Error("expected a refusal");
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : "";

const build = (
  validate?: (provider: ModelProvider, apiKey: string) => Promise<boolean>
) =>
  createModelKeysService({
    clock,
    db,
    secretsKey: SECRETS_KEY,
    validate,
  });

/** A fetch stand-in that records each call and answers with `status`. */
const fakeFetch = (
  status: number,
  calls: { url: string; headers: Headers }[] = []
): typeof fetch =>
  ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ headers: new Headers(init?.headers), url: String(input) });
    return Promise.resolve(new Response("{}", { status }));
  }) as unknown as typeof fetch;

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

    const status = await service.set(user, {
      apiKey: KEY,
      provider: "openrouter",
    });

    expect(status).toEqual({
      configured: true,
      hint: "1234",
      updatedAt: START,
    });
    const reported = await service.status(user, "openrouter");
    expect(reported).toEqual(status);
    expect(JSON.stringify(reported)).not.toContain(KEY);
    expect(JSON.stringify(status)).not.toContain(KEY);
  });

  test("stores the key encrypted, bound to its workspace and row", async () => {
    const service = build();
    await service.set(user, { apiKey: KEY, provider: "openrouter" });

    const stored = modelKeyRow(WORKSPACE)?.apiKeyEnc ?? "";
    expect(stored).not.toBe("");
    expect(stored).not.toContain(KEY);

    const key = await importSecretsKey(SECRETS_KEY);
    expect(
      await decryptSecret(
        key,
        bindingFor(WORKSPACE, `${WORKSPACE}:openrouter`),
        stored
      )
    ).toBe(KEY);
    await expect(
      decryptSecret(
        key,
        bindingFor(OTHER_WORKSPACE, `${WORKSPACE}:openrouter`),
        stored
      )
    ).rejects.toThrow();
    await expect(
      decryptSecret(key, bindingFor(WORKSPACE, `${WORKSPACE}:other`), stored)
    ).rejects.toThrow();
  });

  test("refuses a key the live check rejects, without echoing it, and writes no row", async () => {
    const service = build(async () => false);

    const error = await refusalOf(
      service.set(user, { apiKey: KEY, provider: "openrouter" })
    );

    expect(error).toBeInstanceOf(ServiceError);
    expect(error).toMatchObject({ code: "invalid" });
    expect(messageOf(error)).not.toContain(KEY);
    expect(modelKeyRow(WORKSPACE)).toBeUndefined();
  });

  test("a live check that cannot run is a refusal that does not echo the key and does not call the key bad", async () => {
    const service = build((_provider, apiKey) =>
      Promise.reject(new Error(`request failed for ${apiKey}`))
    );

    const error = await refusalOf(
      service.set(user, { apiKey: KEY, provider: "openrouter" })
    );

    expect(error).toBeInstanceOf(ServiceError);
    expect(error).toMatchObject({ code: "invalid" });
    expect(messageOf(error)).not.toContain(KEY);
    expect(messageOf(error)).not.toContain("did not accept");
    expect(modelKeyRow(WORKSPACE)).toBeUndefined();
  });
});

describe("key shape", () => {
  test("refuses an empty or whitespace-only key", async () => {
    const service = build();

    const errors = await Promise.all(
      ["", "   \n\t "].map((apiKey) =>
        refusalOf(service.set(user, { apiKey, provider: "openrouter" }))
      )
    );

    for (const error of errors) {
      expect(error).toBeInstanceOf(ServiceError);
      expect(error).toMatchObject({ code: "invalid" });
    }
    expect(modelKeyRow(WORKSPACE)).toBeUndefined();
  });

  test("accepts a 511-character key and refuses a 512-character one without echoing it", async () => {
    const service = build();
    const accepted = "Zq".repeat(255).concat("Z");
    const tooLong = "Zq".repeat(256);
    expect(accepted.length).toBe(511);
    expect(tooLong.length).toBe(512);

    const status = await service.set(user, {
      apiKey: accepted,
      provider: "openrouter",
    });
    expect(status.configured).toBe(true);
    expect((await service.resolve(WORKSPACE, "openrouter"))?.apiKey).toBe(
      accepted
    );

    const error = await refusalOf(
      service.set(user, { apiKey: tooLong, provider: "openrouter" })
    );
    expect(error).toBeInstanceOf(ServiceError);
    expect(error).toMatchObject({ code: "invalid" });
    expect(messageOf(error)).not.toContain("Zq");
    // The refused write leaves the earlier key in place.
    expect((await service.resolve(WORKSPACE, "openrouter"))?.apiKey).toBe(
      accepted
    );
  });
});

describe("managed ids and the Anthropic key", () => {
  test("set and remove leave every managed_* row and the Anthropic key row alone", async () => {
    const service = build();
    seedAnthropicIds(WORKSPACE, "mine");
    seedAnthropicIds(OTHER_WORKSPACE, "theirs");
    db.insert(workspaceAnthropicKeys)
      .values({
        apiKeyEnc: "v1:anthropic:stored",
        createdAt: START,
        environmentId: "env_1",
        keyHint: "ANTH",
        setBy: "u1",
        updatedAt: START,
        workspaceId: WORKSPACE,
      })
      .run();
    const before = anthropicIdCounts(WORKSPACE);
    const anthropicRow = anthropicKeyRow(WORKSPACE);
    expect(before).toEqual({
      agents: 1,
      sessions: 1,
      skills: 1,
      skillVersions: 1,
    });

    await service.set(user, { apiKey: KEY, provider: "openrouter" });
    expect(anthropicIdCounts(WORKSPACE)).toEqual(before);
    expect(anthropicKeyRow(WORKSPACE)).toEqual(anthropicRow);

    nowMs += 60_000;
    await service.set(user, { apiKey: ROTATED_KEY, provider: "openrouter" });
    expect(anthropicIdCounts(WORKSPACE)).toEqual(before);
    expect(anthropicKeyRow(WORKSPACE)).toEqual(anthropicRow);

    await service.remove(user, "openrouter");
    expect(anthropicIdCounts(WORKSPACE)).toEqual(before);
    expect(anthropicKeyRow(WORKSPACE)).toEqual(anthropicRow);
    expect(anthropicIdCounts(OTHER_WORKSPACE)).toEqual({
      agents: 1,
      sessions: 1,
      skills: 1,
      skillVersions: 1,
    });
  });
});

describe("resolve", () => {
  test("returns the plaintext key after set", async () => {
    const service = build();
    await service.set(user, { apiKey: KEY, provider: "openrouter" });

    expect(await service.resolve(WORKSPACE, "openrouter")).toEqual({
      apiKey: KEY,
    });
  });

  test("is null for a workspace with no key", async () => {
    expect(await build().resolve(WORKSPACE, "openrouter")).toBeNull();
  });

  test("is null for a workspace whose neighbour has a key", async () => {
    const service = build();
    await service.set(otherWorkspaceUser, {
      apiKey: KEY,
      provider: "openrouter",
    });

    expect(await service.resolve(WORKSPACE, "openrouter")).toBeNull();
    expect((await service.resolve(OTHER_WORKSPACE, "openrouter"))?.apiKey).toBe(
      KEY
    );
  });

  test("is null after remove", async () => {
    const service = build();
    await service.set(user, { apiKey: KEY, provider: "openrouter" });
    await service.remove(user, "openrouter");

    expect(await service.resolve(WORKSPACE, "openrouter")).toBeNull();
  });
});

describe("rotation and remove", () => {
  test("a second set replaces the key and keeps createdAt", async () => {
    const service = build();
    await service.set(user, { apiKey: KEY, provider: "openrouter" });
    const createdAt = modelKeyRow(WORKSPACE)?.createdAt;

    nowMs += 60_000;
    const status = await service.set(user, {
      apiKey: ROTATED_KEY,
      provider: "openrouter",
    });

    expect(status).toEqual({
      configured: true,
      hint: "9876",
      updatedAt: new Date(nowMs).toISOString(),
    });
    expect(modelKeyRow(WORKSPACE)?.createdAt).toBe(createdAt ?? "");
    expect((await service.resolve(WORKSPACE, "openrouter"))?.apiKey).toBe(
      ROTATED_KEY
    );
  });

  test("remove deletes the row, is idempotent, and reports not configured", async () => {
    const service = build();
    await service.set(user, { apiKey: KEY, provider: "openrouter" });

    expect(await service.remove(user, "openrouter")).toEqual(NOT_CONFIGURED);
    expect(await service.remove(user, "openrouter")).toEqual(NOT_CONFIGURED);
    expect(modelKeyRow(WORKSPACE)).toBeUndefined();
    expect(await service.status(user, "openrouter")).toEqual(NOT_CONFIGURED);
  });
});

describe("authorization", () => {
  test("run, machine and system principals cannot set or remove the key", async () => {
    const service = build();
    await service.set(user, { apiKey: KEY, provider: "openrouter" });

    await Promise.all(
      [run, machine, system].flatMap((principal) => [
        expect(
          service.set(principal, {
            apiKey: ROTATED_KEY,
            provider: "openrouter",
          })
        ).rejects.toBeInstanceOf(ForbiddenError),
        expect(service.remove(principal, "openrouter")).rejects.toBeInstanceOf(
          ForbiddenError
        ),
      ])
    );
    expect((await service.resolve(WORKSPACE, "openrouter"))?.apiKey).toBe(KEY);
  });

  test("the system principal cannot read the status", async () => {
    await expect(build().status(system, "openrouter")).rejects.toBeInstanceOf(
      ForbiddenError
    );
  });

  test("a user of another workspace sees its own status, not configured", async () => {
    const service = build();
    await service.set(user, { apiKey: KEY, provider: "openrouter" });

    expect(await service.status(otherWorkspaceUser, "openrouter")).toEqual(
      NOT_CONFIGURED
    );
    expect((await service.status(user, "openrouter")).configured).toBe(true);
  });
});

describe("validateOpenRouterKey", () => {
  test("sends a GET with the key as a bearer token to the models endpoint", async () => {
    const calls: { url: string; headers: Headers }[] = [];

    await validateOpenRouterKey(KEY, fakeFetch(200, calls));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/models/user");
    expect(calls[0]?.headers.get("Authorization")).toBe(`Bearer ${KEY}`);
  });

  test("returns true on 200", async () => {
    expect(await validateOpenRouterKey(KEY, fakeFetch(200))).toBe(true);
  });

  test("returns false on 401 and on 403", async () => {
    expect(await validateOpenRouterKey(KEY, fakeFetch(401))).toBe(false);
    expect(await validateOpenRouterKey(KEY, fakeFetch(403))).toBe(false);
  });

  test("throws on 500 and 429, without the key in the message", async () => {
    const errors = await Promise.all(
      [500, 429].map((status) =>
        refusalOf(validateOpenRouterKey(KEY, fakeFetch(status)))
      )
    );

    for (const error of errors) {
      expect(error).toBeInstanceOf(Error);
      expect(messageOf(error)).not.toContain(KEY);
    }
  });
});

describe("NO_KEY_MESSAGES", () => {
  test("names the OpenRouter key and the Settings section", () => {
    expect(NO_KEY_MESSAGES.openrouter).toBe(
      "This workspace has no OpenRouter API key. Add one in Settings, Model providers."
    );
  });
});
