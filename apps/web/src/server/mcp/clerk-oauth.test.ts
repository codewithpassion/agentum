/// <reference types="bun" />
import { expect, test } from "bun:test";
import { ClerkAPIResponseError } from "@clerk/backend/errors";
import {
  type ClerkOAuthAccessToken,
  clerkOAuthVerifier,
  createOAuthTokenCache,
  looksLikeOAuthToken,
  OAuthVerificationUnavailableError,
  type VerifiedOAuthToken,
} from "./clerk-oauth.ts";

const NOW = Date.parse("2026-09-21T12:00:00.000Z");
const HOUR_MS = 3_600_000;

const LIVE: ClerkOAuthAccessToken = {
  clientId: "client-1",
  expiration: NOW + HOUR_MS,
  expired: false,
  revoked: false,
  scopes: ["profile", "email"],
  subject: "user_1",
  type: "oauth_token",
};

const b64url = (value: unknown) =>
  btoa(JSON.stringify(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
const jwt = (header: Record<string, unknown>) =>
  `${b64url(header)}.${b64url({ sub: "user_1" })}.c2ln`;

const apiError = (status: number) =>
  new ClerkAPIResponseError("Clerk said no", { data: [], status });

/** A stand-in for `clerk.idPOAuthAccessToken.verify` that records calls. */
const fakeVerify = (answer: () => Promise<ClerkOAuthAccessToken>) => {
  const calls: string[] = [];
  const verify = (token: string) => {
    calls.push(token);
    return answer();
  };
  return { calls, verifier: clerkOAuthVerifier({ now: () => NOW, verify }) };
};

const answering = (overrides: Partial<ClerkOAuthAccessToken>) =>
  fakeVerify(() => Promise.resolve({ ...LIVE, ...overrides }));

test("a live oat_ token for a user is verified with one Clerk call", async () => {
  const { calls, verifier } = answering({});
  expect(await verifier("oat_valid")).toEqual({
    clientId: "client-1",
    expiresAt: NOW + HOUR_MS,
    scopes: ["profile", "email"],
    userId: "user_1",
  });
  expect(calls).toEqual(["oat_valid"]);
});

test("an at+jwt access token is sent to Clerk too", async () => {
  const { calls, verifier } = answering({});
  const token = jwt({ alg: "RS256", typ: "at+jwt" });
  expect(await verifier(token)).not.toBeNull();
  expect(calls).toEqual([token]);
  expect(looksLikeOAuthToken(jwt({ typ: "application/at+jwt" }))).toBe(true);
});

test("hm_key_, ak_, mt_, a session JWT and garbage never reach Clerk", async () => {
  const { calls, verifier } = answering({});
  const tokens = [
    "hm_key_abc",
    "ak_live_key",
    "mt_m2m",
    jwt({ alg: "RS256", typ: "JWT" }),
    jwt({ alg: "RS256" }),
    "eyJhbGciOiJSUzI1NiJ9.e30.sig",
    "not.a.jwt!",
    "x",
    `oat_${"a".repeat(5000)}`,
  ];
  const results = await Promise.all(tokens.map((token) => verifier(token)));
  expect(results).toEqual(tokens.map(() => null));
  expect(calls).toEqual([]);
});

test("a 200 answer is refused when revoked, expired or past its expiration", async () => {
  const cases: Partial<ClerkOAuthAccessToken>[] = [
    { revoked: true },
    { expired: true },
    { expiration: NOW - 1 },
    { expiration: NOW },
  ];
  const results = await Promise.all(
    cases.map((overrides) => answering(overrides).verifier("oat_x"))
  );
  expect(results).toEqual(cases.map(() => null));
  expect(await answering({ expiration: null }).verifier("oat_x")).toMatchObject(
    { expiresAt: null }
  );
});

test("Clerk's real opaque answer passes: no type, expiration in Unix seconds", async () => {
  // The shape Clerk's verify endpoint gave on 2026-09-21 (object
  // clerk_idp_oauth_access_token, no `type`, seconds).
  const expiresInSeconds = Math.floor((NOW + HOUR_MS) / 1000);
  const real = { ...LIVE, expiration: expiresInSeconds };
  Reflect.deleteProperty(real, "type");
  const { verifier } = fakeVerify(() => Promise.resolve(real));
  expect(await verifier("oat_x")).toMatchObject({
    expiresAt: expiresInSeconds * 1000,
    userId: "user_1",
  });
  // Seconds in the past are still refused.
  expect(
    await answering({
      expiration: Math.floor((NOW - 1000) / 1000),
      type: null,
    }).verifier("oat_x")
  ).toBeNull();
});

test("a 200 answer of another type, a non-user subject or no client is refused", async () => {
  const cases: Partial<ClerkOAuthAccessToken>[] = [
    { type: "api_key" },
    { type: "m2m_token" },
    { subject: "mch_machine" },
    { subject: "" },
    { clientId: "" },
  ];
  const results = await Promise.all(
    cases.map((overrides) => answering(overrides).verifier("oat_x"))
  );
  expect(results).toEqual(cases.map(() => null));
});

test("Clerk 400, 404 and 422 mean a bad token: null (401)", async () => {
  const statuses = [400, 404, 422];
  const results = await Promise.all(
    statuses.map((status) =>
      fakeVerify(() => Promise.reject(apiError(status))).verifier("oat_x")
    )
  );
  expect(results).toEqual([null, null, null]);
});

test("Clerk 429, 5xx and network errors are an outage, not a bad token", async () => {
  const failures = [
    apiError(429),
    apiError(500),
    apiError(503),
    new TypeError("fetch failed"),
  ];
  const errors = await Promise.all(
    failures.map((failure) =>
      fakeVerify(() => Promise.reject(failure))
        .verifier("oat_x")
        .catch((e: unknown) => e)
    )
  );
  for (const error of errors) {
    expect(error).toBeInstanceOf(OAuthVerificationUnavailableError);
    expect((error as OAuthVerificationUnavailableError).misconfigured).toBe(
      false
    );
  }
});

test("Clerk 401 or 403 means our secret key is wrong: unavailable and flagged", async () => {
  const errors = await Promise.all(
    [401, 403].map((status) =>
      fakeVerify(() => Promise.reject(apiError(status)))
        .verifier("oat_x")
        .catch((e: unknown) => e)
    )
  );
  for (const error of errors) {
    expect(error).toBeInstanceOf(OAuthVerificationUnavailableError);
    expect((error as OAuthVerificationUnavailableError).misconfigured).toBe(
      true
    );
  }
});

test("the thrown error never carries the token", async () => {
  const { verifier } = fakeVerify(() =>
    Promise.reject(new Error("failed for oat_secret_token"))
  );
  const error = await verifier("oat_secret_token").catch((e: unknown) => e);
  expect(String(error)).not.toContain("oat_secret_token");
});

const VERIFIED: VerifiedOAuthToken = {
  clientId: "client-1",
  expiresAt: null,
  scopes: [],
  userId: "user_1",
};

/** A cache with a clock the test moves, and a verifier that counts calls. */
const cacheSetup = (answer: VerifiedOAuthToken | null = VERIFIED) => {
  let now = NOW;
  const cache = createOAuthTokenCache({ maxEntries: 3, now: () => now });
  let calls = 0;
  const verify = () => {
    calls += 1;
    return Promise.resolve(answer);
  };
  return {
    advance: (ms: number) => {
      now += ms;
    },
    cache,
    calls: () => calls,
    verify,
  };
};

test("the cache reuses a success for 60 s, then asks Clerk again", async () => {
  const { advance, cache, calls, verify } = cacheSetup();
  expect(await cache.cached("oat_a", verify)).toEqual(VERIFIED);
  advance(59_000);
  expect(await cache.cached("oat_a", verify)).toEqual(VERIFIED);
  expect(calls()).toBe(1);
  advance(1000);
  await cache.cached("oat_a", verify);
  expect(calls()).toBe(2);
});

test("the cache never outlives the token's own expiry", async () => {
  const { advance, cache, calls, verify } = cacheSetup({
    ...VERIFIED,
    expiresAt: NOW + 10_000,
  });
  await cache.cached("oat_a", verify);
  advance(9000);
  await cache.cached("oat_a", verify);
  expect(calls()).toBe(1);
  advance(1000);
  await cache.cached("oat_a", verify);
  expect(calls()).toBe(2);
});

test("failures and outages are never cached", async () => {
  const refused = cacheSetup(null);
  await refused.cache.cached("oat_a", refused.verify);
  await refused.cache.cached("oat_a", refused.verify);
  expect(refused.calls()).toBe(2);
  expect(refused.cache.size()).toBe(0);

  const { cache } = cacheSetup();
  const down = () => Promise.reject(new Error("down"));
  await cache.cached("oat_a", down).catch(() => null);
  expect(cache.size()).toBe(0);
});

test("the cache is bounded and drops the oldest entry", async () => {
  const { cache, calls, verify } = cacheSetup();
  // In order: the eviction drops the oldest.
  await cache.cached("oat_1", verify);
  await cache.cached("oat_2", verify);
  await cache.cached("oat_3", verify);
  await cache.cached("oat_4", verify);
  expect(cache.size()).toBe(3);
  await cache.cached("oat_4", verify);
  expect(calls()).toBe(4);
  await cache.cached("oat_1", verify);
  expect(calls()).toBe(5);
});

test("tokens that are not OAuth tokens bypass the cache", async () => {
  const { cache, calls, verify } = cacheSetup();
  await cache.cached("ak_x", verify);
  await cache.cached("ak_x", verify);
  expect(calls()).toBe(2);
  expect(cache.size()).toBe(0);
});
