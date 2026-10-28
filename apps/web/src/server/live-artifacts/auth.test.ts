import { expect, test } from "bun:test";
import { createClerkClient } from "@clerk/backend";
import { requestClerk } from "./auth";

const publishableKey = `pk_test_${btoa("example.clerk.accounts.dev$")}`;
const env = {
  CLERK_PUBLISHABLE_KEY: publishableKey,
  CLERK_SECRET_KEY: "sk_test_x",
} as Env;
const request = () =>
  new Request("https://hm.test/live", { headers: { Cookie: "a=b" } });

test("authenticateRequest throws without the publishable key", async () => {
  const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
  await expect(clerk.authenticateRequest(request())).rejects.toThrow();
});

test("requestClerk passes the publishable key so authenticateRequest runs", async () => {
  const result = await requestClerk(env).authenticateRequest(request());
  expect(result.isAuthenticated).toBe(false);
});
