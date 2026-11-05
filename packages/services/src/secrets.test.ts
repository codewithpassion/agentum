import { beforeEach, describe, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { events as eventRows } from "@repo/db/schema/events";
import { runs as runRows } from "@repo/db/schema/runs";
import { secrets as secretRows } from "@repo/db/schema/secrets";
import { sessions as sessionRows } from "@repo/db/schema/sessions";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { type AgentsService, createAgentsService } from "./agents.ts";
import { ForbiddenError } from "./authz.ts";
import { encryptSecret, importSecretsKey } from "./crypto.ts";
import { createEventsService } from "./events.ts";
import type { Clock } from "./runs/types.ts";
import { createSecretsService, type SecretsService } from "./secrets.ts";
import type { Principal } from "./workspaces.ts";

const WORKSPACE = "w1";
const OTHER_WORKSPACE = "w2";
const START = "2026-10-17T10:00:00.000Z";
const OPENAI = "openai-key-0123456789";
const ECHO = "echo-key-abcdef012345";
const SECRETS_KEY = Buffer.from(
  crypto.getRandomValues(new Uint8Array(32))
).toString("base64");

const user: Principal = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: WORKSPACE,
};
const outsider: Principal = {
  kind: "user",
  userId: "u2",
  via: "session",
  workspaceId: OTHER_WORKSPACE,
};
const runPrincipal: Principal = {
  agentId: "ag",
  kind: "run",
  runId: "r1",
  workspaceId: WORKSPACE,
};

const rule = {
  header: "Authorization",
  host: "api.openai.com",
  template: "Bearer {value}",
};

let db: ReturnType<typeof migrated>;
let service: SecretsService;
let agents: AgentsService;
let agentA: string;
let agentB: string;
let nowMs: number;

const clock: Clock = {
  now: () => new Date(nowMs),
  sleep: () => Promise.resolve(),
};

const workspace = (id: string) =>
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

const makeAgent = async (name: string) =>
  (await agents.create(user, { model: "m", name, runtime: "fake" })).id;

/** A session and a run for the agent, so an event can point at them. */
const seedRun = (agentId: string, runId: string) => {
  db.insert(sessionRows)
    .values({
      actorId: "u1",
      actorKind: "user",
      agentId,
      createdAt: START,
      id: `s-${runId}`,
      origin: "ui",
      workspaceId: WORKSPACE,
    })
    .run();
  db.insert(runRows)
    .values({
      actorId: "u1",
      actorKind: "user",
      agentId,
      createdAt: START,
      id: runId,
      inputText: "hi",
      sessionId: `s-${runId}`,
      status: "running",
      workspaceId: WORKSPACE,
    })
    .run();
};

const secretEvents = () =>
  db
    .select()
    .from(eventRows)
    .all()
    .filter((event) => event.type.startsWith("secret."));

const failure = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to reject");
};

beforeEach(async () => {
  db = migrated();
  nowMs = Date.parse(START);
  workspace(WORKSPACE);
  workspace(OTHER_WORKSPACE);
  const store = new Map<string, string>();
  const events = createEventsService({
    blobs: {
      get: (key) => Promise.resolve(store.get(key) ?? null),
      put: (key, body) => {
        store.set(key, body);
        return Promise.resolve();
      },
    },
    db,
  });
  agents = createAgentsService({ db, events });
  service = createSecretsService({
    atomic: sqliteAtomic(db),
    clock,
    db,
    events,
    secretsKey: SECRETS_KEY,
  });
  agentA = await makeAgent("Agent A");
  agentB = await makeAgent("Agent B");
});

const proxySecret = (name = "OPENAI_API_KEY", value = OPENAI) =>
  service.create(user, { mode: "proxy", name, rules: [rule], value });

describe("storing", () => {
  test("a value is stored encrypted and no read returns it", async () => {
    const created = await proxySecret();
    const updated = await service.update(user, created.id, {
      value: ECHO,
    });
    const listed = await service.list(user);
    const grants = await service.setGrants(user, agentA, [created.id]);

    const [row] = db.select().from(secretRows).all();
    expect(row?.valueEnc.startsWith("v1:")).toBe(true);
    expect(row?.valueEnc).not.toContain(OPENAI);
    expect(row?.valueEnc).not.toContain(ECHO);
    for (const read of [created, updated, listed, grants]) {
      const text = JSON.stringify(read);
      expect(text).not.toContain(OPENAI);
      expect(text).not.toContain(ECHO);
    }
    expect(Object.keys(listed[0] ?? {}).sort()).toEqual([
      "allowedHosts",
      "createdAt",
      "id",
      "mode",
      "name",
      "rules",
      "updatedAt",
    ]);
  });

  test("a ciphertext moved to another secret does not decrypt", async () => {
    const first = await proxySecret("FIRST_KEY");
    const second = await proxySecret("SECOND_KEY", ECHO);
    await service.setGrants(user, agentA, [first.id, second.id]);
    const [a] = db
      .select()
      .from(secretRows)
      .where(eq(secretRows.id, first.id))
      .all();
    db.update(secretRows)
      .set({ valueEnc: a?.valueEnc ?? "" })
      .where(eq(secretRows.id, second.id))
      .run();
    expect(
      await failure(service.resolveForAgent(WORKSPACE, agentA))
    ).toBeInstanceOf(Error);
  });

  test("a name is unique per workspace", async () => {
    await proxySecret();
    expect(await failure(proxySecret())).toMatchObject({ code: "conflict" });
    await service.create(outsider, {
      mode: "env",
      name: "OPENAI_API_KEY",
      value: OPENAI,
    });
  });

  test.each([
    ["a name with a dash", { name: "OPEN-AI" }],
    ["a name that starts with a digit", { name: "1KEY" }],
    ["SECRETS_KEY", { name: "SECRETS_KEY" }],
    ["a lowercase run token key", { name: "run_token_key" }],
    ["an ANTHROPIC_ name", { name: "ANTHROPIC_API_KEY" }],
    ["a AGENTUM_ name", { name: "AGENTUM_RELAY_TOKEN" }],
    ["PATH", { name: "PATH" }],
    ["a proxy variable", { name: "https_proxy" }],
    ["a CA bundle variable", { name: "NODE_EXTRA_CA_CERTS" }],
    ["BASH_ENV", { name: "BASH_ENV" }],
    ["PYTHONSTARTUP", { name: "PYTHONSTARTUP" }],
    ["GIT_SSH_COMMAND", { name: "GIT_SSH_COMMAND" }],
    ["BUN_OPTIONS", { name: "BUN_OPTIONS" }],
    ["BUN_CONFIG_REGISTRY", { name: "BUN_CONFIG_REGISTRY" }],
    ["a short value", { value: "short" }],
    ["an Agentum token", { value: "hm_run_abcdefghijklmnop" }],
    ["a renamed platform token", { value: "ag_key_abcdefghijklmnop" }],
    ["a value with a NUL", { value: "abcdefgh\0ij" }],
  ])("refuses %s", async (_label, change) => {
    const input = {
      mode: "env" as const,
      name: "GOOD_NAME",
      value: OPENAI,
      ...change,
    };
    expect(await failure(service.create(user, input))).toBeDefined();
    expect(db.select().from(secretRows).all()).toHaveLength(0);
  });

  test("an ordinary name is still accepted next to the refused ones", async () => {
    const created = await service.create(user, {
      mode: "env",
      name: "OPENAI_API_KEY",
      value: OPENAI,
    });
    expect(created).toMatchObject({ mode: "env", name: "OPENAI_API_KEY" });
  });

  test("a proxy secret needs rules, an env secret takes none, and a proxy value must fit a header", async () => {
    expect(
      await failure(
        service.create(user, {
          mode: "proxy",
          name: "NO_RULES",
          rules: [],
          value: OPENAI,
        })
      )
    ).toBeDefined();
    expect(
      await failure(
        service.create(user, {
          mode: "proxy",
          name: "BAD_VALUE",
          rules: [rule],
          value: "line one\nline two!",
        })
      )
    ).toMatchObject({ code: "invalid" });
    expect(
      await failure(
        service.create(user, {
          mode: "env",
          name: "WITH_RULES",
          rules: [rule],
          value: OPENAI,
        } as never)
      )
    ).toBeDefined();
    // An env secret may be a multi-line value, such as a PEM key.
    await service.create(user, {
      mode: "env",
      name: "PEM_KEY",
      value: "-----BEGIN KEY-----\nabc\n-----END KEY-----",
    });
  });

  test("an update replaces the value, bumps the version and changes the revision", async () => {
    const created = await proxySecret();
    await service.setGrants(user, agentA, [created.id]);
    const before = await service.resolveForAgent(WORKSPACE, agentA);
    nowMs += 1000;
    await service.update(user, created.id, { value: ECHO });
    const after = await service.resolveForAgent(WORKSPACE, agentA);
    expect(after.revision).not.toBe(before.revision);
    const matches = await service.proxyFor(WORKSPACE, agentA, "api.openai.com");
    expect(matches.map((match) => match.value)).toEqual([ECHO]);
    expect(
      db.select().from(secretRows).where(eq(secretRows.id, created.id)).get()
        ?.version
    ).toBe(2);
  });

  test("an update can switch a secret between env and proxy", async () => {
    const created = await service.create(user, {
      mode: "env",
      name: "SWITCHER_KEY",
      value: OPENAI,
    });
    expect(
      await failure(service.update(user, created.id, { mode: "proxy" }))
    ).toMatchObject({ code: "invalid" });
    const proxied = await service.update(user, created.id, {
      mode: "proxy",
      rules: [rule],
    });
    expect(proxied.mode).toBe("proxy");
    expect(proxied.rules).toEqual([rule]);
    const back = await service.update(user, created.id, { mode: "env" });
    expect(back.rules).toEqual([]);
  });

  test("another workspace cannot see, change or delete a secret", async () => {
    const created = await proxySecret();
    expect(await service.list(outsider)).toEqual([]);
    expect(
      await failure(service.update(outsider, created.id, { value: ECHO }))
    ).toMatchObject({ code: "not_found" });
    await service.remove(outsider, created.id);
    expect(await service.list(user)).toHaveLength(1);
  });

  test("only a signed-in user manages secrets", async () => {
    expect(await failure(service.list(runPrincipal))).toBeInstanceOf(
      ForbiddenError
    );
    expect(await failure(service.list({ kind: "system" }))).toBeInstanceOf(
      ForbiddenError
    );
    expect(
      await failure(
        service.create(runPrincipal, {
          mode: "env",
          name: "SNEAKY_KEY",
          value: OPENAI,
        })
      )
    ).toBeInstanceOf(ForbiddenError);
  });
});

describe("grants", () => {
  test("grants are per agent", async () => {
    const created = await proxySecret();
    const env = await service.create(user, {
      mode: "env",
      name: "PLAIN_KEY",
      value: ECHO,
    });
    await service.setGrants(user, agentA, [created.id, env.id]);

    expect(await service.grantsOf(user, agentA)).toEqual(
      [created.id, env.id].sort()
    );
    expect(await service.grantsOf(user, agentB)).toEqual([]);

    const forA = await service.resolveForAgent(WORKSPACE, agentA);
    expect(forA.env).toEqual({ PLAIN_KEY: ECHO });
    expect(forA.proxy).toEqual([
      { hosts: ["api.openai.com"], name: "OPENAI_API_KEY" },
    ]);
    const forB = await service.resolveForAgent(WORKSPACE, agentB);
    expect(forB.env).toEqual({});
    expect(forB.proxy).toEqual([]);
    expect(await service.maskerFor(WORKSPACE, agentB)).toBeNull();
    expect(await service.proxyFor(WORKSPACE, agentB, "api.openai.com")).toEqual(
      []
    );
  });

  test("setGrants replaces the whole set and revoking removes the secret from the run", async () => {
    const one = await proxySecret();
    const two = await service.create(user, {
      mode: "env",
      name: "SECOND_KEY",
      value: ECHO,
    });
    await service.setGrants(user, agentA, [one.id, two.id]);
    await service.setGrants(user, agentA, [two.id]);
    expect(await service.grantsOf(user, agentA)).toEqual([two.id]);
    expect(await service.proxyFor(WORKSPACE, agentA, "api.openai.com")).toEqual(
      []
    );
    await service.setGrants(user, agentA, []);
    expect(await service.grantsOf(user, agentA)).toEqual([]);
  });

  test("a grant needs an agent and a secret of the same workspace", async () => {
    const created = await proxySecret();
    const foreign = await service.create(outsider, {
      mode: "env",
      name: "FOREIGN_KEY",
      value: ECHO,
    });
    expect(
      await failure(service.setGrants(user, agentA, [foreign.id]))
    ).toMatchObject({ code: "not_found" });
    expect(
      await failure(service.setGrants(user, "no-such-agent", [created.id]))
    ).toMatchObject({ code: "not_found" });
    expect(
      await failure(service.setGrants(outsider, agentA, [foreign.id]))
    ).toMatchObject({ code: "not_found" });
    expect(await service.grantsOf(user, agentA)).toEqual([]);
  });

  test("deleting a secret removes its grants", async () => {
    const created = await proxySecret();
    await service.setGrants(user, agentA, [created.id]);
    await service.remove(user, created.id);
    expect(await service.grantsOf(user, agentA)).toEqual([]);
    expect(db.select().from(secretRows).all()).toHaveLength(0);
    await service.remove(user, created.id);
  });
});

describe("allowed hosts", () => {
  test("an env secret keeps its allowed hosts, lower-cased and without repeats", async () => {
    const created = await service.create(user, {
      allowedHosts: ["API.Example.com", "*.example.org", "api.example.com"],
      mode: "env",
      name: "HOSTED_KEY",
      value: ECHO,
    });
    expect(created.allowedHosts).toEqual(["api.example.com", "*.example.org"]);
    const [listed] = await service.list(user);
    expect(listed?.allowedHosts).toEqual(["api.example.com", "*.example.org"]);
  });

  test("an env secret created without hosts has none", async () => {
    const created = await service.create(user, {
      mode: "env",
      name: "PLAIN_KEY",
      value: ECHO,
    });
    expect(created.allowedHosts).toEqual([]);
  });

  test("a proxy secret given allowed hosts is refused, on create and on update", async () => {
    expect(
      await failure(
        service.create(user, {
          allowedHosts: ["api.openai.com"],
          mode: "proxy",
          name: "OPENAI_API_KEY",
          rules: [rule],
          value: OPENAI,
        } as never)
      )
    ).toBeDefined();
    expect(db.select().from(secretRows).all()).toHaveLength(0);

    const proxied = await proxySecret();
    expect(
      await failure(
        service.update(user, proxied.id, { allowedHosts: ["api.openai.com"] })
      )
    ).toMatchObject({ code: "invalid" });
  });

  test.each([
    ["localhost", "localhost"],
    ["a bare wildcard suffix", "*.com"],
    ["a URL", "https://api.example.com"],
  ])("refuses a host that is %s", async (_label, host) => {
    expect(
      await failure(
        service.create(user, {
          allowedHosts: [host],
          mode: "env",
          name: "BAD_HOST_KEY",
          value: ECHO,
        })
      )
    ).toBeDefined();
    expect(db.select().from(secretRows).all()).toHaveLength(0);
  });

  test("an update sets and clears the hosts and bumps the version", async () => {
    const created = await service.create(user, {
      mode: "env",
      name: "HOST_KEY",
      value: ECHO,
    });
    const set = await service.update(user, created.id, {
      allowedHosts: ["api.example.com"],
    });
    expect(set.allowedHosts).toEqual(["api.example.com"]);
    const [listed] = await service.list(user);
    expect(listed?.allowedHosts).toEqual(["api.example.com"]);

    const cleared = await service.update(user, created.id, {
      allowedHosts: [],
    });
    expect(cleared.allowedHosts).toEqual([]);
    expect(
      db.select().from(secretRows).where(eq(secretRows.id, created.id)).get()
        ?.version
    ).toBe(3);
  });

  test("switching an env secret with hosts to proxy clears the hosts", async () => {
    const created = await service.create(user, {
      allowedHosts: ["api.openai.com"],
      mode: "env",
      name: "SWITCH_HOSTS",
      value: OPENAI,
    });
    const proxied = await service.update(user, created.id, {
      mode: "proxy",
      rules: [rule],
    });
    expect(proxied.allowedHosts).toEqual([]);
    expect(
      db.select().from(secretRows).where(eq(secretRows.id, created.id)).get()
        ?.allowedHosts
    ).toBe("[]");
  });

  test("placeholdersFor lists granted env secrets only, with hosts and no value", async () => {
    const hosted = await service.create(user, {
      allowedHosts: ["api.example.com"],
      mode: "env",
      name: "HOSTED_KEY",
      value: ECHO,
    });
    const bare = await service.create(user, {
      mode: "env",
      name: "BARE_KEY",
      value: "bare-value-0123456",
    });
    const proxied = await proxySecret();
    await service.setGrants(user, agentA, [hosted.id, bare.id, proxied.id]);

    const placeholders = await service.placeholdersFor(WORKSPACE, agentA);
    expect(placeholders).toEqual([
      { hosts: [], name: "BARE_KEY" },
      { hosts: ["api.example.com"], name: "HOSTED_KEY" },
    ]);
    const text = JSON.stringify(placeholders);
    expect(text).not.toContain(ECHO);
    expect(text).not.toContain("bare-value-0123456");
    expect(text).not.toContain(OPENAI);

    expect(await service.placeholdersFor(WORKSPACE, agentB)).toEqual([]);
    expect(await service.placeholdersFor(OTHER_WORKSPACE, agentA)).toEqual([]);
  });

  test("envGrantsFor returns the agent's granted env secrets with value and hosts", async () => {
    const hosted = await service.create(user, {
      allowedHosts: ["api.example.com"],
      mode: "env",
      name: "HOSTED_KEY",
      value: ECHO,
    });
    const other = await service.create(user, {
      mode: "env",
      name: "OTHER_KEY",
      value: "other-value-0123",
    });
    const proxied = await proxySecret();
    await service.setGrants(user, agentA, [hosted.id, proxied.id]);
    await service.setGrants(user, agentB, [other.id]);

    expect(await service.envGrantsFor(WORKSPACE, agentA)).toEqual([
      { hosts: ["api.example.com"], name: "HOSTED_KEY", value: ECHO },
    ]);
    expect(await service.envGrantsFor(WORKSPACE, agentB)).toEqual([
      { hosts: [], name: "OTHER_KEY", value: "other-value-0123" },
    ]);
    expect(await service.envGrantsFor(OTHER_WORKSPACE, agentA)).toEqual([]);
  });

  test("list never carries a secret value, env or proxy", async () => {
    const proxied = await proxySecret();
    const hosted = await service.create(user, {
      allowedHosts: ["api.example.com"],
      mode: "env",
      name: "HOSTED_KEY",
      value: ECHO,
    });
    await service.setGrants(user, agentA, [proxied.id, hosted.id]);
    const text = JSON.stringify(await service.list(user));
    expect(text).not.toContain(OPENAI);
    expect(text).not.toContain(ECHO);
  });
});

describe("proxy rules", () => {
  test("a request matches by host, exact or wildcard, and not outside the grant", async () => {
    const created = await service.create(user, {
      mode: "proxy",
      name: "MIXED_KEY",
      rules: [
        rule,
        { header: "x-api-key", host: "*.example.com", template: "{value}" },
      ],
      value: OPENAI,
    });
    await service.setGrants(user, agentA, [created.id]);

    const exact = await service.proxyFor(WORKSPACE, agentA, "api.openai.com");
    expect(exact).toEqual([
      {
        header: "Authorization",
        headerValue: `Bearer ${OPENAI}`,
        name: "MIXED_KEY",
        value: OPENAI,
      },
    ]);
    const wild = await service.proxyFor(WORKSPACE, agentA, "api.EXAMPLE.com");
    expect(wild.map((match) => match.header)).toEqual(["x-api-key"]);
    expect(wild[0]?.headerValue).toBe(OPENAI);
    expect(await service.proxyFor(WORKSPACE, agentA, "example.com")).toEqual(
      []
    );
    expect(await service.proxyFor(WORKSPACE, agentA, "evil.com")).toEqual([]);
    // The same host in another workspace is not this agent's.
    expect(
      await service.proxyFor(OTHER_WORKSPACE, agentA, "api.openai.com")
    ).toEqual([]);
  });

  test("proxyForNames returns the named proxy secrets' rules for a host, without an agent grant", async () => {
    await service.create(user, {
      mode: "proxy",
      name: "NAMED_KEY",
      rules: [rule],
      value: OPENAI,
    });
    await service.create(user, {
      mode: "env",
      name: "NAMED_ENV",
      value: ECHO,
    });
    // No agent grant is needed: the names come from a version's grants.
    expect(
      await service.proxyForNames(
        WORKSPACE,
        ["NAMED_KEY", "NAMED_ENV", "MISSING"],
        "API.openai.com"
      )
    ).toEqual([
      {
        header: "Authorization",
        headerValue: `Bearer ${OPENAI}`,
        name: "NAMED_KEY",
        value: OPENAI,
      },
    ]);
    expect(
      await service.proxyForNames(WORKSPACE, ["NAMED_KEY"], "evil.com")
    ).toEqual([]);
    expect(
      await service.proxyForNames(WORKSPACE, [], "api.openai.com")
    ).toEqual([]);
    expect(
      await service.proxyForNames(
        OTHER_WORKSPACE,
        ["NAMED_KEY"],
        "api.openai.com"
      )
    ).toEqual([]);
  });

  test("an env secret is never added to a request", async () => {
    const env = await service.create(user, {
      mode: "env",
      name: "PLAIN_KEY",
      value: ECHO,
    });
    await service.setGrants(user, agentA, [env.id]);
    expect(await service.proxyFor(WORKSPACE, agentA, "api.openai.com")).toEqual(
      []
    );
  });
});

describe("redaction and events", () => {
  test("the masker replaces every granted value, env and proxy, with its name", async () => {
    const proxied = await proxySecret();
    const env = await service.create(user, {
      mode: "env",
      name: "PLAIN_KEY",
      value: ECHO,
    });
    await service.setGrants(user, agentA, [proxied.id, env.id]);
    const masker = await service.maskerFor(WORKSPACE, agentA);
    expect(masker?.mask(`a ${OPENAI} b ${ECHO} c`)).toBe(
      "a [secret:OPENAI_API_KEY] b [secret:PLAIN_KEY] c"
    );
    expect(
      masker?.maskDeep({ nested: [{ text: JSON.stringify({ k: OPENAI }) }] })
    ).toEqual({ nested: [{ text: '{"k":"[secret:OPENAI_API_KEY]"}' }] });
  });

  test("delivery and injection events hold names and hosts, never a value", async () => {
    const proxied = await proxySecret();
    const env = await service.create(user, {
      mode: "env",
      name: "PLAIN_KEY",
      value: ECHO,
    });
    await service.setGrants(user, agentA, [proxied.id, env.id]);
    const resolved = await service.resolveForAgent(WORKSPACE, agentA);
    seedRun(agentA, "run-1");
    const run = { agentId: agentA, runId: "run-1", workspaceId: WORKSPACE };
    await service.announceDelivery(run, {
      env: Object.keys(resolved.env),
      proxy: resolved.proxy,
      surface: "cloud",
    });
    await service.announceInjection(run, {
      host: "api.openai.com",
      names: ["OPENAI_API_KEY"],
      via: "relay",
    });
    const stored = secretEvents();
    expect(stored.map((event) => event.type).sort()).toEqual([
      "secret.delivered",
      "secret.injected",
    ]);
    const text = JSON.stringify(stored);
    expect(text).not.toContain(OPENAI);
    expect(text).not.toContain(ECHO);
    expect(text).toContain("PLAIN_KEY");
    expect(text).toContain("api.openai.com");
  });

  test("a run with nothing granted announces nothing", async () => {
    await service.announceDelivery(
      { agentId: agentB, runId: "run-2", workspaceId: WORKSPACE },
      { env: [], proxy: [], surface: "machine" }
    );
    expect(secretEvents()).toHaveLength(0);
  });
});

test("assistant workspace masker skips values shorter than eight characters", async () => {
  await service.create(user, {
    allowedHosts: [],
    mode: "env",
    name: "SHORT",
    value: "temporary-long-value",
  });
  await service.create(user, {
    allowedHosts: [],
    mode: "env",
    name: "LONG",
    value: "12345678",
  });
  const shortId =
    (await service.list(user)).find((row) => row.name === "SHORT")?.id ?? "";
  await db
    .update(secretRows)
    .set({
      valueEnc: await encryptSecret(
        await importSecretsKey(SECRETS_KEY),
        {
          field: "value",
          rowId: shortId,
          table: "secrets",
          workspaceId: WORKSPACE,
        },
        "hello"
      ),
    })
    .where(eq(secretRows.id, shortId));
  const masker = await service.workspaceMasker(WORKSPACE);
  expect(masker.mask("hello 12345678")).toBe("hello [secret:LONG]");
});

test("secure card receipts read stored metadata and grants in the caller's workspace", async () => {
  const secret = await service.create(user, {
    allowedHosts: ["api.example.com"],
    mode: "env",
    name: "TOKEN",
    value: OPENAI,
  });
  await service.setGrants(user, agentA, [secret.id]);
  expect(await service.describe(user, secret.id)).toMatchObject({
    ...secret,
    grantedTo: [agentA],
  });
  await expect(service.describe(outsider, secret.id)).rejects.toThrow(
    "Secret not found"
  );
});
