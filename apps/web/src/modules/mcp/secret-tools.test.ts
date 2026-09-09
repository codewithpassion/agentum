import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { generateConnectorKey } from "#/crypto";
import { createDb, type Db } from "#/db/client";
import { listActivity } from "#/modules/activity/service";
import { TOOL_OUTPUT_MAX_BYTES, truncateText } from "#/modules/computer/output";

/**
 * The broker, from the agent's side of the table.
 *
 * Every assertion here is one of two questions: did the value reach the wire,
 * and did anything the agent can read ever contain it. The three misses of
 * `resolveSecretForAgent` get one message between them, because a message that
 * told them apart would be an existence oracle across tenants.
 */

// The router and the computer tools reach Durable Objects; none is called
// here, and the base class only has to exist for the modules to load.
mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  env: {},
}));

const { createAgent } = await import("#/modules/agents/service");
const { createSecret, getSecret, grantSecret } = await import(
  "#/modules/secrets/service"
);
const { createWorkspace } = await import("#/modules/workspaces/service");
const { checkUrl, redactSecret, registerSecretTools } = await import(
  "./secret-tools"
);
type McpToolContext = import("./tools").McpToolContext;

const ADA_ID = "user_2aAdaAAAAAAAAAAAAAAAAAAA";
const BOB_ID = "user_2bBobBBBBBBBBBBBBBBBBBBB";

const NAME = "DEEPGRAM_API_KEY";
const VALUE = "sk-live-ABCDEFGHIJKLMNOP";
const HOST = "api.deepgram.com";

const migrate = (): { d1: D1Database; db: Db } => {
  const dir = new URL("../../../drizzle/", import.meta.url);
  const journal = JSON.parse(
    readFileSync(new URL("meta/_journal.json", dir), "utf8")
  ) as { entries: { tag: string }[] };

  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  for (const entry of journal.entries) {
    const sql = readFileSync(new URL(`${entry.tag}.sql`, dir), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      sqlite.run(statement);
    }
  }

  const d1 = {
    batch: (statements: { all: () => Promise<unknown> }[]) =>
      Promise.all(statements.map((statement) => statement.all())),
    prepare: (query: string) => {
      const stmt = sqlite.query(query);
      return {
        bind: (...params: SQLQueryBindings[]) => ({
          all: () => Promise.resolve({ results: stmt.all(...params) }),
          raw: () => Promise.resolve(stmt.values(...params)),
          run: () => Promise.resolve(stmt.run(...params)),
        }),
      };
    },
  } as unknown as D1Database;
  return { d1, db: createDb(d1) };
};

type ToolHandler = (input: Record<string, unknown>) => Promise<CallToolResult>;

/** The registration call is the seam, as in `tools.test.ts`. */
const toolsOf = (ctx: McpToolContext): Map<string, ToolHandler> => {
  const handlers = new Map<string, ToolHandler>();
  registerSecretTools(
    {
      registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
        handlers.set(name, handler);
      },
    } as unknown as McpServer,
    ctx
  );
  return handlers;
};

const textOf = (result: CallToolResult): string => {
  const [block] = result.content;
  return block?.type === "text" ? block.text : "";
};

const payloadOf = (result: CallToolResult): Record<string, unknown> =>
  JSON.parse(textOf(result)) as Record<string, unknown>;

interface FetchCall {
  headers: Headers;
  init: RequestInit;
  url: string;
}

const realFetch = globalThis.fetch;

/** Records what reached the wire, and answers with whatever the test scripted. */
const stubFetch = (
  reply: (url: string) => Response | Promise<Response> | Error
): FetchCall[] => {
  const calls: FetchCall[] = [];
  globalThis.fetch = ((url: string, init: RequestInit = {}) => {
    calls.push({ headers: new Headers(init.headers), init, url });
    const answer = reply(url);
    return answer instanceof Error
      ? Promise.reject(answer)
      : Promise.resolve(answer);
  }) as unknown as typeof fetch;
  return calls;
};

const ok = (body: string, headers: Record<string, string> = {}): Response =>
  new Response(body, { headers, status: 200 });

interface Tenant {
  agentId: string;
  ctx: McpToolContext;
  tools: Map<string, ToolHandler>;
  workspace: { id: string; slug: string };
}

let db: Db;
let env: Env;
let alpha: Tenant;
let beta: Tenant;

const seed = async (name: string, clerkUserId: string): Promise<Tenant> => {
  const { workspace } = await createWorkspace(db, {
    name,
    owner: {
      clerkUserId,
      email: `${clerkUserId}@example.com`,
      imageUrl: null,
      name: `Owner of ${name}`,
    },
  });
  const ref = { id: workspace.id, slug: workspace.slug };
  const { agent } = await createAgent(db, workspace.id, {
    instructions: "",
    name: "Researcher",
    runtime: "cloudflare",
    soul: "",
  });
  const ctx: McpToolContext = {
    agent,
    db,
    env,
    requestUrl: "https://agentum.test/mcp",
    workspace: ref,
  };
  return { agentId: agent.id, ctx, tools: toolsOf(ctx), workspace: ref };
};

/** A secret of `tenant`, granted to its agent unless told otherwise. */
const secretFor = async (
  tenant: Tenant,
  overrides: {
    allowedHosts?: string[];
    grantTo?: string | null;
    header?: string;
    headerPrefix?: string;
    name?: string;
    value?: string;
  } = {}
) => {
  const secret = await createSecret(db, env, tenant.workspace.id, {
    allowedHosts: overrides.allowedHosts ?? [HOST],
    clerkUserId: ADA_ID,
    description: "Speech to text.",
    header: overrides.header,
    headerPrefix: overrides.headerPrefix,
    name: overrides.name ?? NAME,
    value: overrides.value ?? VALUE,
  });
  const grantee =
    overrides.grantTo === undefined ? tenant.agentId : overrides.grantTo;
  if (grantee) {
    await grantSecret(db, secret.id, grantee);
  }
  return secret;
};

const call = (tenant: Tenant, input: Record<string, unknown>) => {
  const handler = tenant.tools.get("http_request");
  if (!handler) {
    throw new Error("http_request is not registered");
  }
  return handler(input);
};

beforeEach(async () => {
  const migrated = migrate();
  ({ db } = migrated);
  env = {
    CONNECTOR_KEY: generateConnectorKey(),
    DB: migrated.d1,
  } as unknown as Env;
  alpha = await seed("Alpha", ADA_ID);
  beta = await seed("Beta", BOB_ID);
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// --- the pure parts ----------------------------------------------------------

describe("redactSecret", () => {
  test("replaces every occurrence with the secret's name", () => {
    const text = `key=${VALUE} and again ${VALUE}.`;

    expect(redactSecret(text, { name: NAME, value: VALUE })).toBe(
      `key=[REDACTED:${NAME}] and again [REDACTED:${NAME}].`
    );
  });

  test("leaves the text alone when there is no secret", () => {
    expect(redactSecret("plain", null)).toBe("plain");
  });

  test("an empty value is not a match on every character", () => {
    // `"abc".replaceAll("", "X")` is `"XaXbXcX"`; the guard is why it is not.
    expect(redactSecret("abc", { name: NAME, value: "" })).toBe("abc");
  });

  test("catches a value that straddles the truncation boundary", () => {
    const head = "a".repeat(TOOL_OUTPUT_MAX_BYTES - 10);
    const body = `${head}${VALUE}${"b".repeat(2000)}`;

    // Redacting after the cut would leave the first ten characters of the key
    // sitting at the end of the output - which is the whole reason for the
    // order in `perform`.
    const wrongOrder = redactSecret(
      truncateText(body, TOOL_OUTPUT_MAX_BYTES).text,
      { name: NAME, value: VALUE }
    );
    expect(wrongOrder).toContain(VALUE.slice(0, 10));

    const rightOrder = truncateText(
      redactSecret(body, { name: NAME, value: VALUE }),
      TOOL_OUTPUT_MAX_BYTES
    ).text;
    // The placeholder is what lands on the cut now, and half of "[REDACTED:"
    // is harmless in a way that half of a key is not.
    expect(rightOrder).toContain("[REDACTED:");
    expect(rightOrder).not.toContain(VALUE.slice(0, 10));
  });
});

describe("checkUrl", () => {
  test("accepts an absolute https URL", () => {
    const result = checkUrl(`https://${HOST}/v1/listen?model=nova`);

    expect(result.ok).toBe(true);
    expect(result.ok && result.url.hostname).toBe(HOST);
  });

  test("refuses anything that is not https", () => {
    for (const url of [`http://${HOST}/v1`, "file:///etc/passwd"]) {
      const result = checkUrl(url);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toContain(
        "only makes https"
      );
    }
  });

  test("refuses somebody's own network", () => {
    const targets = [
      "https://localhost/x",
      "https://127.0.0.1/x",
      "https://10.0.0.5/x",
      "https://192.168.1.1/x",
      "https://172.16.4.4/x",
      "https://169.254.169.254/latest/meta-data",
      "https://100.64.0.1/x",
      "https://vault.internal/x",
    ];
    for (const url of targets) {
      const result = checkUrl(url);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toContain(
        "private or loopback"
      );
    }
  });

  test("refuses something that is not a URL at all", () => {
    const result = checkUrl("api.deepgram.com/v1");

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("not a valid URL");
  });
});

// --- list_secrets ------------------------------------------------------------

describe("list_secrets", () => {
  test("is the caller's grants, with no hint and no id", async () => {
    await secretFor(alpha);
    await secretFor(alpha, { grantTo: null, name: "UNGRANTED_KEY" });

    const handler = alpha.tools.get("list_secrets");
    const payload = payloadOf(await (handler as ToolHandler)({}));

    expect(payload.secrets).toEqual([
      { allowedHosts: [HOST], description: "Speech to text.", name: NAME },
    ]);
  });

  test("never shows another workspace's secrets", async () => {
    await secretFor(beta);

    const handler = alpha.tools.get("list_secrets");
    expect(payloadOf(await (handler as ToolHandler)({})).secrets).toEqual([]);
  });
});

// --- the grant check ---------------------------------------------------------

describe("http_request and the three misses", () => {
  const REFUSAL = `No secret named ${NAME} is granted to you.`;

  test("a secret that never existed", async () => {
    const calls = stubFetch(() => ok("{}"));

    const result = await call(alpha, {
      secret: NAME,
      url: `https://${HOST}/v1/listen`,
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(REFUSAL);
    expect(calls).toHaveLength(0);
  });

  test("a secret of another workspace reads exactly the same", async () => {
    await secretFor(beta);
    const calls = stubFetch(() => ok("{}"));

    const result = await call(alpha, {
      secret: NAME,
      url: `https://${HOST}/v1/listen`,
    });

    expect(textOf(result)).toContain(REFUSAL);
    expect(calls).toHaveLength(0);
  });

  test("a secret of this workspace granted to nobody reads the same again", async () => {
    await secretFor(alpha, { grantTo: null });
    const calls = stubFetch(() => ok("{}"));

    const result = await call(alpha, {
      secret: NAME,
      url: `https://${HOST}/v1/listen`,
    });

    expect(textOf(result)).toContain(REFUSAL);
    expect(calls).toHaveLength(0);
  });
});

describe("http_request and the allowlist", () => {
  test("refuses a host the secret does not allow, before any request", async () => {
    await secretFor(alpha);
    const calls = stubFetch(() => ok("{}"));

    const result = await call(alpha, {
      secret: NAME,
      url: "https://api.example.com/v1/listen",
    });

    expect(result.isError).toBe(true);
    // Naming the hosts is what lets the agent correct itself.
    expect(textOf(result)).toContain(
      `${NAME} may only be sent to ${HOST}, not api.example.com`
    );
    expect(textOf(result)).toContain("Nothing was requested.");
    expect(calls).toHaveLength(0);
  });

  test("a suffix that is not a label boundary is not a match", async () => {
    await secretFor(alpha);
    const calls = stubFetch(() => ok("{}"));

    const result = await call(alpha, {
      secret: NAME,
      url: `https://evil-${HOST}/v1`,
    });

    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("a refused host is not a use: no activity row, no last_used_at", async () => {
    const secret = await secretFor(alpha);
    stubFetch(() => ok("{}"));

    await call(alpha, { secret: NAME, url: "https://api.example.com/v1" });

    const feed = await listActivity(db, { agentId: alpha.agentId, limit: 10 });
    expect(feed.entries).toHaveLength(0);
    expect(
      (await getSecret(db, alpha.workspace.id, secret.id))?.lastUsedAt
    ).toBe(null);
  });
});

// --- injection ---------------------------------------------------------------

describe("http_request with a secret", () => {
  test("puts the value on the wire and never in the answer", async () => {
    await secretFor(alpha);
    const calls = stubFetch(() =>
      ok(`{"echo":"Bearer ${VALUE}","ok":true}`, {
        "content-type": "application/json",
      })
    );

    const result = await call(alpha, {
      body: '{"url":"https://example.com/a.wav"}',
      headers: { "content-type": "application/json" },
      method: "POST",
      secret: NAME,
      url: `https://${HOST}/v1/listen`,
    });

    // On the wire, in full.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${VALUE}`);
    expect(calls[0]?.init.method).toBe("POST");

    // In the answer, never.
    const payload = payloadOf(result);
    expect(payload.status).toBe(200);
    expect(payload.body).toContain(`[REDACTED:${NAME}]`);
    expect(textOf(result)).not.toContain(VALUE);
  });

  test("redacts a value echoed back in a response header too", async () => {
    await secretFor(alpha);
    stubFetch(() => ok("{}", { "content-type": `text/plain; key=${VALUE}` }));

    const result = await call(alpha, {
      secret: NAME,
      url: `https://${HOST}/v1/listen`,
    });

    expect(textOf(result)).not.toContain(VALUE);
    expect(textOf(result)).toContain(`[REDACTED:${NAME}]`);
  });

  test("an agent-supplied header of the same name is ignored, whatever its case", async () => {
    await secretFor(alpha);
    const calls = stubFetch(() => ok("{}"));

    await call(alpha, {
      // Lower-case, so a check for "Authorization" alone would let it past.
      headers: { authorization: "Bearer attacker-controlled" },
      secret: NAME,
      url: `https://${HOST}/v1/listen`,
    });

    const sent = calls[0]?.headers;
    expect(sent?.get("authorization")).toBe(`Bearer ${VALUE}`);
    expect(sent?.get("authorization")).not.toContain("attacker-controlled");
  });

  test("honours the secret's own header and prefix", async () => {
    await secretFor(alpha, { header: "x-api-key", headerPrefix: "" });
    const calls = stubFetch(() => ok("{}"));

    await call(alpha, { secret: NAME, url: `https://${HOST}/v1/listen` });

    expect(calls[0]?.headers.get("x-api-key")).toBe(VALUE);
    expect(calls[0]?.headers.get("authorization")).toBe(null);
  });

  test("does not follow a redirect while a key is attached", async () => {
    await secretFor(alpha);
    const calls = stubFetch(() =>
      Response.redirect("https://attacker.example/steal", 302)
    );

    const result = await call(alpha, {
      secret: NAME,
      url: `https://${HOST}/v1/listen`,
    });

    // `fetch` replays Authorization across a redirect, so the 3xx comes back
    // to the agent as it is rather than being followed with the key attached.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.redirect).toBe("manual");
    const payload = payloadOf(result);
    expect(payload.status).toBe(302);
    expect((payload.headers as Record<string, string>).location).toBe(
      "https://attacker.example/steal"
    );
  });

  test("logs the call and bumps last_used_at", async () => {
    const secret = await secretFor(alpha);
    stubFetch(() => ok("{}"));

    await call(alpha, {
      method: "POST",
      secret: NAME,
      url: `https://${HOST}/v1/listen?model=nova`,
    });

    const feed = await listActivity(db, { agentId: alpha.agentId, limit: 10 });
    const [entry] = feed.entries;
    expect(entry?.kind).toBe("http.request");
    expect(entry?.summary).toBe(`POST ${HOST}/v1/listen → 200`);
    // No headers, no body - and no query string, which is where a key would
    // end up if anyone ignored the header-only rule.
    expect(entry?.detail).toEqual({
      host: HOST,
      method: "POST",
      path: "/v1/listen",
      secret: NAME,
      status: 200,
    });
    expect(
      (await getSecret(db, alpha.workspace.id, secret.id))?.lastUsedAt
    ).not.toBe(null);
  });

  test("a thrown fetch error is redacted before the agent sees it", async () => {
    await secretFor(alpha);
    stubFetch(() => new Error(`upstream rejected Bearer ${VALUE}`));

    const result = await call(alpha, {
      secret: NAME,
      url: `https://${HOST}/v1/listen`,
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain(VALUE);
    expect(textOf(result)).toContain(`[REDACTED:${NAME}]`);

    // The value had already been handed to the runtime, so it counts as a use.
    const feed = await listActivity(db, { agentId: alpha.agentId, limit: 10 });
    expect(feed.entries[0]?.summary).toBe(`GET ${HOST}/v1/listen → failed`);
  });

  test("truncates a long body, after redacting it", async () => {
    await secretFor(alpha);
    const head = "a".repeat(TOOL_OUTPUT_MAX_BYTES - 10);
    stubFetch(() => ok(`${head}${VALUE}${"b".repeat(2000)}`));

    const result = await call(alpha, {
      secret: NAME,
      url: `https://${HOST}/v1/listen`,
    });

    const payload = payloadOf(result);
    expect(payload.truncated).toBe(true);
    expect(payload.body).toContain("[truncated: showing the first");
    expect(textOf(result)).not.toContain(VALUE.slice(0, 10));
  });
});

// --- bodies -----------------------------------------------------------------

describe("http_request and a body the method cannot carry", () => {
  test("refuses a GET with a body before anything is resolved", async () => {
    const secret = await secretFor(alpha);
    const calls = stubFetch(() => ok("{}"));

    const result = await call(alpha, {
      body: '{"q":"x"}',
      method: "GET",
      secret: NAME,
      url: `https://${HOST}/v1/listen`,
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("A GET request cannot have a body");
    expect(calls).toHaveLength(0);

    // The point of refusing here rather than letting `fetch` throw: no request
    // was made, so this is not a use of the key.
    const feed = await listActivity(db, { agentId: alpha.agentId, limit: 10 });
    expect(feed.entries).toHaveLength(0);
    expect(
      (await getSecret(db, alpha.workspace.id, secret.id))?.lastUsedAt
    ).toBe(null);
  });

  test("GET is the default, so a bare body is refused too", async () => {
    const calls = stubFetch(() => ok("{}"));

    const result = await call(alpha, {
      body: "x",
      url: "https://example.com/thing",
    });

    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("a body on POST is fine", async () => {
    const calls = stubFetch(() => ok("{}"));

    await call(alpha, {
      body: "x",
      method: "POST",
      url: "https://example.com/thing",
    });

    expect(calls).toHaveLength(1);
  });
});

// --- the response read cap ---------------------------------------------------

describe("http_request and an oversized response", () => {
  /** A body that never ends, counting how many chunks were actually pulled. */
  const endlessBody = (chunkBytes: number) => {
    const state = { pulls: 0 };
    const chunk = new TextEncoder().encode("a".repeat(chunkBytes));
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        state.pulls += 1;
        controller.enqueue(chunk);
      },
    });
    return { state, stream };
  };

  test("stops reading instead of buffering the whole thing", async () => {
    const chunkBytes = 8192;
    const { state, stream } = endlessBody(chunkBytes);
    stubFetch(() => new Response(stream, { status: 200 }));

    const result = await call(alpha, { url: "https://example.com/huge" });

    const payload = payloadOf(result);
    expect(payload.status).toBe(200);
    expect(payload.truncated).toBe(true);
    expect(payload.body).toContain("was not read past");

    // Enough chunks to pass 2x the output cap, and then it stopped: a stream
    // that never ends must not be able to run the isolate out of memory.
    const enough = Math.ceil((TOOL_OUTPUT_MAX_BYTES * 2) / chunkBytes);
    expect(state.pulls).toBeLessThanOrEqual(enough + 1);
    expect(String(payload.body).length).toBeLessThan(TOOL_OUTPUT_MAX_BYTES * 2);
  });

  test("a body that fits is returned whole, with no cap note", async () => {
    stubFetch(() => ok("small enough"));

    const payload = payloadOf(
      await call(alpha, { url: "https://example.com/small" })
    );

    expect(payload.body).toBe("small enough");
    expect(payload.truncated).toBe(false);
  });

  test("redaction still runs on what was kept", async () => {
    await secretFor(alpha);
    // The key in the first chunk, then filler for ever: the read stops long
    // after the key, so it has to be redacted out of what was kept.
    const encoder = new TextEncoder();
    const filler = encoder.encode("a".repeat(8192));
    let first = true;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (first) {
          first = false;
          controller.enqueue(encoder.encode(`leaked ${VALUE} `));
          return;
        }
        controller.enqueue(filler);
      },
    });
    stubFetch(() => new Response(stream, { status: 200 }));

    const result = await call(alpha, {
      secret: NAME,
      url: `https://${HOST}/v1/listen`,
    });

    expect(textOf(result)).not.toContain(VALUE);
  });
});

// --- redirects on the unauthenticated path -----------------------------------

describe("http_request and a redirect chain", () => {
  /** Answers each URL in turn from a scripted map, recording the order. */
  const chain = (routes: Record<string, () => Response>) => {
    const calls: FetchCall[] = [];
    globalThis.fetch = ((url: string, init: RequestInit = {}) => {
      calls.push({ headers: new Headers(init.headers), init, url });
      const route = routes[url];
      return Promise.resolve(
        route ? route() : new Response("end", { status: 200 })
      );
    }) as unknown as typeof fetch;
    return { calls };
  };

  const redirect =
    (to: string, status = 302) =>
    () =>
      new Response(null, { headers: { location: to }, status });

  test("follows a hop to a public host and reports the final status", async () => {
    const { calls } = chain({
      "https://example.com/a": redirect("https://example.com/b"),
      "https://example.com/b": () => new Response("arrived", { status: 200 }),
    });

    const payload = payloadOf(
      await call(alpha, { url: "https://example.com/a" })
    );

    expect(calls).toHaveLength(2);
    expect(payload.status).toBe(200);
    expect(payload.body).toBe("arrived");
  });

  test("refuses a hop to a private address, which is the whole point", async () => {
    const { calls } = chain({
      "https://example.com/a": redirect(
        "https://169.254.169.254/latest/meta-data"
      ),
    });

    const result = await call(alpha, { url: "https://example.com/a" });

    // The first hop was fine and the guard never saw the second one when
    // `fetch` was doing the following. Now it does.
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(
      "example.com redirected to 169.254.169.254"
    );
    expect(textOf(result)).toContain("private or loopback");
    expect(calls).toHaveLength(1);
  });

  test("resolves a relative location against the URL it came from", async () => {
    const { calls } = chain({
      "https://example.com/one/a": redirect("../two/b"),
    });

    await call(alpha, { url: "https://example.com/one/a" });

    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe("https://example.com/two/b");
  });

  test("stops a chain that never lands", async () => {
    const routes: Record<string, () => Response> = {};
    for (let i = 0; i < 10; i += 1) {
      routes[`https://example.com/${i}`] = redirect(
        `https://example.com/${i + 1}`
      );
    }
    const { calls } = chain(routes);

    const result = await call(alpha, { url: "https://example.com/0" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("redirected more than 5 times");
    // The first request plus five hops, and then it gave up.
    expect(calls).toHaveLength(6);
  });

  test("drops the agent's own credentials on a cross-host hop", async () => {
    const { calls } = chain({
      "https://example.com/a": redirect("https://elsewhere.example/b"),
    });

    await call(alpha, {
      headers: { authorization: "Bearer the-agents-own-token" },
      url: "https://example.com/a",
    });

    expect(calls[0]?.headers.get("authorization")).toBe(
      "Bearer the-agents-own-token"
    );
    // Replaying it to whatever a public host names is the same leak the secret
    // path holds redirects back for.
    expect(calls[1]?.headers.get("authorization")).toBe(null);
  });

  test("a 302 turns a POST into a bodyless GET, a 307 does not", async () => {
    const { calls } = chain({
      "https://example.com/a": redirect("https://example.com/b"),
    });
    await call(alpha, {
      body: "payload",
      method: "POST",
      url: "https://example.com/a",
    });
    expect(calls[1]?.init.method).toBe("GET");
    expect(calls[1]?.init.body).toBeUndefined();

    const preserved = chain({
      "https://example.com/a": redirect("https://example.com/b", 307),
    });
    await call(alpha, {
      body: "payload",
      method: "POST",
      url: "https://example.com/a",
    });
    expect(preserved.calls[1]?.init.method).toBe("POST");
    expect(preserved.calls[1]?.init.body).toBe("payload");
  });

  test("logs one row for the chain, against the final host, with the hops", async () => {
    chain({
      "https://example.com/a": redirect("https://elsewhere.example/b"),
    });

    await call(alpha, { method: "POST", url: "https://example.com/a" });

    const feed = await listActivity(db, { agentId: alpha.agentId, limit: 10 });
    expect(feed.entries).toHaveLength(1);
    const [entry] = feed.entries;
    expect(entry?.summary).toBe("POST elsewhere.example/b → 200");
    expect(entry?.detail).toEqual({
      hops: 1,
      host: "elsewhere.example",
      method: "POST",
      path: "/b",
      secret: null,
      status: 200,
    });
  });

  test("a refused chain is still recorded, since the first request was made", async () => {
    chain({
      "https://example.com/a": redirect("https://10.0.0.1/admin"),
    });

    await call(alpha, { url: "https://example.com/a" });

    const feed = await listActivity(db, { agentId: alpha.agentId, limit: 10 });
    const [entry] = feed.entries;
    expect(entry?.summary).toBe("GET example.com/a → 302");
    expect(
      (entry?.detail as { hops?: number } | undefined)?.hops
    ).toBeUndefined();
  });

  test("a secret-carrying request still never follows anything", async () => {
    await secretFor(alpha);
    const { calls } = chain({
      [`https://${HOST}/v1`]: redirect(`https://${HOST}/v2`),
    });

    const payload = payloadOf(
      await call(alpha, { secret: NAME, url: `https://${HOST}/v1` })
    );

    // Even a same-host redirect is handed back: the agent decides.
    expect(calls).toHaveLength(1);
    expect(payload.status).toBe(302);
  });
});

// --- the unauthenticated path ------------------------------------------------

describe("http_request without a secret", () => {
  test("is a plain https request", async () => {
    const calls = stubFetch(() =>
      ok("hello", { "content-type": "text/plain" })
    );

    const result = await call(alpha, { url: "https://example.com/thing" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.get("authorization")).toBe(null);
    // Manual on both paths now, for opposite reasons: with a key so a 3xx is
    // never followed, without one so every hop can be checked before it is.
    expect(calls[0]?.init.redirect).toBe("manual");
    const payload = payloadOf(result);
    expect(payload.status).toBe(200);
    expect(payload.body).toBe("hello");
  });

  test("keeps the same URL guards", async () => {
    const calls = stubFetch(() => ok("hello"));

    const insecure = await call(alpha, { url: "http://example.com/thing" });
    const internal = await call(alpha, { url: "https://169.254.169.254/" });

    expect(insecure.isError).toBe(true);
    expect(internal.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("is logged with no secret named", async () => {
    stubFetch(() => ok("hello"));

    await call(alpha, { url: "https://example.com/thing" });

    const feed = await listActivity(db, { agentId: alpha.agentId, limit: 10 });
    const [entry] = feed.entries;
    expect(entry?.summary).toBe("GET example.com/thing → 200");
    expect((entry?.detail as { secret: unknown } | undefined)?.secret).toBe(
      null
    );
  });
});
