import { afterEach, beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { credentials, oauthStates } from "@repo/db/schema/connectors";
import { migrated } from "@repo/db/test-db";
import type { Fetcher } from "@repo/services/connectors/mcp";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import { Hono } from "hono";
import {
  type StubMcp,
  startStubMcp,
} from "../../../../../scripts/dev/stub-mcp.ts";
import { type Composed, composeWith, type Infra } from "../compose.ts";
import { connectorOAuthRoutes } from "./connectors-oauth.ts";
import type { AppEnv } from "./groups.ts";

// The guard refuses http and loopback, so the stub is reached as a public
// https host through this fetch, which also tells the stub its public host.
const PUBLIC_HOST = "mcp.stub-test.com";
const PUBLIC_ORIGIN = `https://${PUBLIC_HOST}`;
const APP = "https://hm.example.com";
const SECRETS_KEY = Buffer.from(new Uint8Array(32).fill(5)).toString("base64");
const APPROVE_LINK = /id="approve" href="([^"]+)"/;

interface Session {
  orgId: string | null;
  userId: string | null;
}
const USER_A: Session = { orgId: "org_a", userId: "user_a" };
const USER_B: Session = { orgId: "org_a", userId: "user_b" };
const OUTSIDER: Session = { orgId: "org_b", userId: "user_out" };
const NO_ORG: Session = { orgId: null, userId: "user_lonely" };
const SIGNED_OUT: Session = { orgId: null, userId: null };

let db: ReturnType<typeof migrated>;
let stub: StubMcp;
let composed: Composed;
let session: Session;
let connectorId: string;
let agentId: string;
// Every URL the server asked the stub for, so a test can see a registration.
let requested: string[];

const toStub: Fetcher = (input, init) => {
  requested.push(String(input));
  const headers = new Headers(init?.headers);
  headers.set("x-forwarded-host", PUBLIC_HOST);
  headers.set("x-forwarded-proto", "https");
  return fetch(String(input).replace(PUBLIC_ORIGIN, new URL(stub.url).origin), {
    ...init,
    headers,
  });
};

const infra = (): Infra => {
  const store = new Map<string, string>();
  return {
    atomic: sqliteAtomic(db),
    blobs: {
      get: (key) => Promise.resolve(store.get(key) ?? null),
      put: (key, body) => {
        store.set(key, body);
        return Promise.resolve();
      },
    },
    clock: systemClock,
    devFakeRuntime: true,
    fetch: toStub,
    fileBlobs: memoryFileBlobs(),
    relay: noopRelay,
    secretsKey: SECRETS_KEY,
  };
};

const app = new Hono<AppEnv>();
app.use("*", async (c, next) => {
  c.set("composed", composed);
  await next();
});
app.route("/", connectorOAuthRoutes({ session: () => session }));

beforeEach(async () => {
  db = migrated();
  stub = startStubMcp({ oauth: true });
  requested = [];
  session = USER_A;
  composed = composeWith({
    allowedOrgIds: ["org_a", "org_b"],
    db,
    infra: infra(),
  });
  const workspace = await composed.services.workspaces.forOrg({
    clerkOrgId: "org_a",
  });
  const other = await composed.services.workspaces.forOrg({
    clerkOrgId: "org_b",
  });
  if (!(workspace && other)) {
    throw new Error("org_a and org_b must be allowed");
  }
  const owner = await principalOf(USER_A);
  const connector = await composed.services.connectors.create(owner, {
    name: "Stub",
    url: `${PUBLIC_ORIGIN}/mcp`,
  });
  connectorId = connector.id;
  agentId = (
    await composed.services.agents.create(owner, {
      model: "claude-sonnet",
      name: "Bruce",
      runtime: "fake",
    })
  ).id;
});

afterEach(() => {
  stub.stop();
});

const principalOf = async (who: Session) => {
  const principal = await composed.services.workspaces.sessionPrincipal({
    orgId: who.orgId,
    userId: who.userId ?? "",
  });
  if (!principal) {
    throw new Error("The session has no workspace");
  }
  return principal;
};

const connectAt = (
  path: string,
  headers?: Record<string, string>
): Promise<Response> =>
  Promise.resolve(app.request(`${APP}${path}`, { headers }));

const registrations = (): string[] =>
  requested.filter((url) => new URL(url).pathname === "/oauth/register");

const SAME_ORIGIN = { "Sec-Fetch-Site": "same-origin" };

/** `/connect/:id`, then the click on Approve. Returns the callback path. */
const approvedCallback = async (query: string): Promise<string> => {
  const started = await connectAt(
    `/connect/${connectorId}${query}`,
    SAME_ORIGIN
  );
  if (started.status !== 302) {
    throw new Error(`/connect answered ${started.status}`);
  }
  const page = await (
    await toStub(started.headers.get("location") ?? "")
  ).text();
  const link = APPROVE_LINK.exec(page)?.[1];
  if (!link) {
    throw new Error("The consent page has no link.");
  }
  const url = new URL(link.replaceAll("&amp;", "&"));
  return `${url.pathname}${url.search}`;
};

const stateRows = () => db.select().from(oauthStates).all();
const credentialRows = () => db.select().from(credentials).all();

test("connecting as the user redirects to the provider, then back to return_to", async () => {
  const callback = await approvedCallback("?as=user&return_to=%2Fconnectors");
  expect(stateRows()).toHaveLength(1);

  const done = await connectAt(callback);

  expect(done.status).toBe(302);
  expect(done.headers.get("location")).toBe("/connectors?connected=1");
  expect(stateRows()).toHaveLength(0);
  expect(credentialRows()).toMatchObject([
    { ownerId: "user_a", ownerKind: "user", status: "ok", version: 1 },
  ]);
});

test("connecting as an agent stores a credential owned by the agent", async () => {
  const callback = await approvedCallback(`?as=agent:${agentId}`);

  const done = await connectAt(callback);

  expect(done.headers.get("location")).toBe(
    `/agents/${agentId}?sheet=tools&connected=1`
  );
  expect(credentialRows()).toMatchObject([
    { ownerId: agentId, ownerKind: "agent", version: 1 },
  ]);
});

test("a callback completed by a different signed-in user is refused and the state row is deleted", async () => {
  const callback = await approvedCallback("?as=user");
  expect(stateRows()).toHaveLength(1);
  session = USER_B;

  const done = await connectAt(callback);

  expect(done.status).toBe(403);
  expect(stateRows()).toHaveLength(0);
  expect(credentialRows()).toHaveLength(0);
  // The initiator cannot finish with the spent state either.
  session = USER_A;
  expect((await connectAt(callback)).status).toBe(400);
  expect(credentialRows()).toHaveLength(0);
});

test("a callback from someone with no workspace is refused and leaves the state", async () => {
  const callback = await approvedCallback("?as=user");
  session = NO_ORG;

  expect((await connectAt(callback)).status).toBe(401);
  session = SIGNED_OUT;
  expect((await connectAt(callback)).status).toBe(401);
  expect(credentialRows()).toHaveLength(0);
});

test("an off-site return_to is refused at /connect and starts nothing", async () => {
  const responses = await Promise.all(
    [
      "https://evil.example/",
      "//evil.example",
      "%2F%2Fevil.example",
      "%2F%5Cevil.example",
    ].map((returnTo) =>
      connectAt(`/connect/${connectorId}?return_to=${returnTo}`)
    )
  );
  expect(responses.map((res) => res.status)).toEqual([400, 400, 400, 400]);
  expect(stateRows()).toHaveLength(0);
});

test("?as=agent from a non-member is refused", async () => {
  session = OUTSIDER;
  const outsiderAgent = await connectAt(
    `/connect/${connectorId}?as=agent:${agentId}`,
    SAME_ORIGIN
  );
  expect(outsiderAgent.status).toBe(404);

  session = NO_ORG;
  const lonely = await connectAt(
    `/connect/${connectorId}?as=agent:${agentId}`,
    SAME_ORIGIN
  );
  expect(lonely.status).toBe(403);

  expect(stateRows()).toHaveLength(0);
});

test("?as=agent without fetch metadata goes to the agent page and starts nothing", async () => {
  const res = await connectAt(`/connect/${connectorId}?as=agent:${agentId}`);

  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe(`/agents/${agentId}?sheet=tools`);
  expect(stateRows()).toHaveLength(0);
  expect(registrations()).toHaveLength(0);
});

test("?as=agent with Sec-Fetch-Site same-origin starts the flow for that agent", async () => {
  const res = await connectAt(
    `/connect/${connectorId}?as=agent:${agentId}`,
    SAME_ORIGIN
  );

  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toStartWith(
    `${PUBLIC_ORIGIN}/oauth/authorize`
  );
  expect(stateRows()).toMatchObject([{ ownerId: agentId, ownerKind: "agent" }]);
});

test("without Sec-Fetch-Site, a Referer from this origin starts the agent flow", async () => {
  const res = await connectAt(`/connect/${connectorId}?as=agent:${agentId}`, {
    Referer: `${APP}/agents/${agentId}?sheet=tools`,
  });

  expect(res.headers.get("location")).toStartWith(
    `${PUBLIC_ORIGIN}/oauth/authorize`
  );
  expect(stateRows()).toHaveLength(1);
});

test("a foreign Referer or a cross-site navigation to ?as=agent goes to the agent page and starts nothing", async () => {
  const refused: Record<string, string>[] = [
    { Referer: "https://evil.example/x" },
    { "Sec-Fetch-Site": "cross-site" },
  ];
  const responses = await Promise.all(
    refused.map((headers) =>
      connectAt(`/connect/${connectorId}?as=agent:${agentId}`, headers)
    )
  );

  for (const res of responses) {
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/agents/${agentId}?sheet=tools`);
  }
  expect(stateRows()).toHaveLength(0);
  expect(registrations()).toHaveLength(0);
});

test("?as=user needs no fetch metadata and starts the flow", async () => {
  const res = await connectAt(`/connect/${connectorId}?as=user`);

  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toStartWith(
    `${PUBLIC_ORIGIN}/oauth/authorize`
  );
  expect(stateRows()).toMatchObject([{ ownerId: "user_a", ownerKind: "user" }]);
});

test("a signed-out visitor to /connect is sent to the login page", async () => {
  session = SIGNED_OUT;

  const res = await connectAt(`/connect/${connectorId}?as=user`);

  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/login");
  expect(stateRows()).toHaveLength(0);
});

test("denying access at the provider returns to the page with the reason", async () => {
  const started = await connectAt(`/connect/${connectorId}?as=user`);
  const authorize = new URL(started.headers.get("location") ?? "");
  const state = authorize.searchParams.get("state") ?? "";

  const done = await connectAt(
    `/api/connectors/oauth/callback?error=access_denied&state=${state}`
  );

  expect(done.status).toBe(302);
  expect(done.headers.get("location")).toBe(
    "/settings/connectors?connect_error=access_denied"
  );
  expect(credentialRows()).toHaveLength(0);
});

test("a callback without state is a bad request", async () => {
  const res = await connectAt("/api/connectors/oauth/callback?code=abc");

  expect(res.status).toBe(400);
});
