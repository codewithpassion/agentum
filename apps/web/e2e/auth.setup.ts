import { expect, test as setup } from "@playwright/test";
import { STORAGE_STATE } from "../playwright.config";

/**
 * Establishes a real Clerk session once, via the dev-login flow:
 * `GET /api/dev-login` mints a one-time sign-in token and redirects to
 * `/dev-login`, which redeems it client-side and lands on the workspace.
 * The resulting cookies are reused by every test project.
 */
setup("authenticate via dev login", async ({ page, context }) => {
  const response = await page.goto("/api/dev-login");
  expect(
    response?.ok(),
    'Dev login failed. Check DEV_LOGIN_EMAIL in apps/web/.env.local and run "bun run create-dev-user".'
  ).toBe(true);

  await page.waitForURL("/");
  // The sidebar only renders once Clerk reports a signed-in user.
  await expect(
    page.getByRole("navigation", { name: "Workspace" })
  ).toBeVisible();

  await context.storageState({ path: STORAGE_STATE });
});
