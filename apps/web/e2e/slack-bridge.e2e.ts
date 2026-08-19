import { expect, type Page, test } from "@playwright/test";

/**
 * The bridging UI, reachable by clicking (docs/plan.md 2d): channel header →
 * Settings → "Connect to Slack".
 *
 * The suite has no Slack credentials - and must never need any - so what it
 * asserts is the degraded state: the section explains which variables are
 * missing instead of offering a form that could not work.
 */

const RUN_ID = Date.now().toString(36);
const CHANNEL_NAME = `bridge-${RUN_ID}`;

const gotoWorkspace = async (page: Page): Promise<void> => {
  const channelsLoaded = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/channels" &&
      response.request().method() === "GET"
  );
  await page.goto("/");
  await channelsLoaded;
};

test("offers Slack bridging from the channel settings, and says so when it is not configured", async ({
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
  await expect(notConfigured).toContainText("Slack not configured");
  await expect(notConfigured).toContainText("SLACK_BOT_TOKEN");
  await expect(notConfigured).toContainText("SLACK_SIGNING_SECRET");
  // Without credentials there is nothing to fill in, so no form is offered.
  await expect(settings.getByTestId("slack-bridge-form")).toHaveCount(0);
});
