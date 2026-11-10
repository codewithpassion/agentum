import { expect, test } from "bun:test";
import { healthRoutes } from "./health.ts";

test("health answers ok and returns no user id", async () => {
  const response = await healthRoutes.request("/api/health");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
});
