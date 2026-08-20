import { expect, type Page, test } from "@playwright/test";

/**
 * The bridging UI, reachable by clicking (docs/plan.md 2d): channel header →
 * Settings → "Connect to Slack".
 *
 * The suite has no Slack credentials - and must never need any - so what it
 * asserts is the state before any agent is connected: bridging is offered only
 * through an agent's own Slack app, so with none connected there is no form,
 * just the way to get one (docs/plan-slack-apps-per-agent.md).
 */

const RUN_ID = Date.now().toString(36);
const CHANNEL_NAME = `bridge-${RUN_ID}`;

const gotoWorkspace = async (page: Page): Promise<void> => {
  // Channels are workspace-scoped (`/api/w/:slug/channels`), and which slug the
  // landing page picks is not this test's business.
  const channelsLoaded = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith("/channels") &&
      response.request().method() === "GET"
  );
  await page.goto("/");
  await channelsLoaded;
};

test("offers Slack bridging from the channel settings, and points at an agent's Slack app when none is connected", async ({
  page,
}) => {
  await gotoWorkspace(page);

  await page.getByRole("button", { exact: true, name: "Create" }).click();
  await page.getByRole("button", { exact: true, name: "New channel" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(CHANNEL_NAME);
  await dialog.getByRole("button", { name: "Create channel" }).click();

  const conversation = page.getByTestId("conversation");
  await expect(
    conversation.getByRole("heading", { name: `# ${CHANNEL_NAME}` })
  ).toBeVisible();

  await page.getByTestId("channel-settings-button").click();
  const settings = page.getByTestId("channel-settings");
  await expect(
    settings.getByRole("heading", { name: "Connect to Slack" })
  ).toBeVisible();

  const notConfigured = settings.getByTestId("slack-not-configured");
  await expect(notConfigured).toContainText("Connect an agent to Slack first");
  // With no connected agent there is nothing to bridge through, so no form.
  await expect(settings.getByTestId("slack-bridge-form")).toHaveCount(0);
});
