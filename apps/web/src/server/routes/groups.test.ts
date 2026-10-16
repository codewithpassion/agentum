import { expect, test } from "bun:test";
import { Hono } from "hono";
import { type AppEnv, bearerGroup, cookieGroup } from "./groups.ts";

const app = new Hono<AppEnv>();

const cookie = cookieGroup();
cookie.post("/", (c) => c.text("ok"));
app.route("/cookie", cookie);

const bearer = bearerGroup();
bearer.post("/", (c) => c.text("ok"));
app.route("/bearer", bearer);

app.post("/other", (c) => c.text("ok"));

const formPost = (url: string, origin: string) =>
  app.request(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin,
    },
    body: "a=1",
  });

test("cookie group rejects a cross-site form post with 403", async () => {
  const res = await formPost("http://localhost/cookie", "https://evil.example");
  expect(res.status).toBe(403);
});

test("bearer group accepts the same cross-site form post", async () => {
  const res = await formPost("http://localhost/bearer", "https://evil.example");
  expect(res.status).toBe(200);
});

test("cookie group accepts a same-origin form post", async () => {
  const res = await formPost("http://localhost/cookie", "http://localhost");
  expect(res.status).toBe(200);
});

test("cookie group accepts a JSON post", async () => {
  const res = await app.request("http://localhost/cookie", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ a: 1 }),
  });
  expect(res.status).toBe(200);
});

test("cookie group mounted at a prefix leaves a sibling route alone", async () => {
  const res = await formPost("http://localhost/other", "https://evil.example");
  expect(res.status).toBe(200);
});
