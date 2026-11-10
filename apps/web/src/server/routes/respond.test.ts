import { expect, test } from "bun:test";
import { ForbiddenError } from "@repo/services/authz";
import { ServiceError } from "@repo/services/errors";
import { Hono } from "hono";
import type { AppEnv } from "./groups.ts";
import {
  bearerChallenge,
  bearerUnauthorized,
  jsonError,
  serviceRefusal,
  sessionUser,
  tokenUnauthorized,
} from "./respond.ts";

const run = (handler: (c: Parameters<typeof jsonError>[0]) => Response) =>
  new Hono<AppEnv>().get("/", handler).request("/");

test("jsonError writes the status and an error body", async () => {
  const response = await run((c) => jsonError(c, 418, "Short and stout."));
  expect(response.status).toBe(418);
  expect(await response.json()).toEqual({ error: "Short and stout." });
});

test("serviceRefusal hides what a forbidden error says", async () => {
  const response = await run((c) =>
    serviceRefusal(c, new ForbiddenError("secret detail"))
  );
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "Not allowed." });
});

test("serviceRefusal passes a service error's message and status", async () => {
  const response = await run((c) =>
    serviceRefusal(c, new ServiceError("not_found", "No such thing."))
  );
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "No such thing." });
});

test("serviceRefusal rethrows anything else", async () => {
  const boom = new Error("bug");
  const response = await new Hono<AppEnv>()
    .onError((error, c) => c.text(error.message, 500))
    .get("/", (c) => serviceRefusal(c, boom))
    .request("/");
  expect(response.status).toBe(500);
  expect(await response.text()).toBe("bug");
});

test("bearerChallenge names the realm and any extra parameters", () => {
  expect(bearerChallenge()).toBe('Bearer realm="agentum"');
  expect(bearerChallenge(['error="invalid_token"'])).toBe(
    'Bearer realm="agentum", error="invalid_token"'
  );
});

test("bearerUnauthorized is a 401 with a challenge", async () => {
  const response = bearerUnauthorized("invalid_token", [
    'error="invalid_token"',
  ]);
  expect(response.status).toBe(401);
  expect(response.headers.get("WWW-Authenticate")).toBe(
    'Bearer realm="agentum", error="invalid_token"'
  );
  expect(await response.json()).toEqual({ error: "invalid_token" });
});

test("bearerUnauthorized defaults to the bare challenge", async () => {
  const response = bearerUnauthorized();
  expect(response.headers.get("WWW-Authenticate")).toBe(
    'Bearer realm="agentum"'
  );
  expect(await response.json()).toEqual({ error: "unauthorized" });
});

test("sessionUser is null without a signed-in user", async () => {
  const app = new Hono<AppEnv>().get("/", async (c) => {
    const principal = await sessionUser(c, { session: () => null });
    return c.json({ principal });
  });
  expect(await (await app.request("/")).json()).toEqual({ principal: null });
});

test("tokenUnauthorized separates a bad token from none", async () => {
  const bad = tokenUnauthorized(true, ['resource_metadata="https://x/m"']);
  expect(bad.headers.get("WWW-Authenticate")).toBe(
    'Bearer realm="agentum", resource_metadata="https://x/m", error="invalid_token"'
  );
  expect(await bad.json()).toEqual({ error: "invalid_token" });
  const none = tokenUnauthorized(false);
  expect(none.headers.get("WWW-Authenticate")).toBe('Bearer realm="agentum"');
  expect(await none.json()).toEqual({ error: "unauthorized" });
});
