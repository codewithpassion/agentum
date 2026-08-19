import { Buffer } from "node:buffer";
import { expect, type Locator, type Page, test } from "@playwright/test";

/**
 * Phase 3c acceptance script (docs/plan.md 3c): the right rail's Screen, Files
 * and Activity tabs, driven by clicking. The suite runs with `--mode e2e`, so
 * no agent ever wakes - the computer and activity APIs still work fully, which
 * is what makes an upload observable in all three tabs. The browser has no
 * session here, so the Screen tab must land on its empty or unreachable state.
 */

const RUN_ID = Date.now().toString(36);
const AGENT_NAME = `RailAgent${RUN_ID}`;
const AGENT_SOUL = `Watches its own screen (${RUN_ID}).`;
const FILE_NAME = `notes-${RUN_ID}.txt`;
const FILE_BODY = `uploaded from the files tab ${RUN_ID}`;

const railOf = (page: Page): Locator => page.getByTestId("agent-rail");

/**
 * Clerk remounts the tree once it resolves the session, which wipes state a
 * click set up before that; the workspace's channel request is the signal that
 * the final tree is mounted, so the sidebar can be clicked safely.
 */
const gotoWorkspace = async (page: Page): Promise<void> => {
  const channelsLoaded = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/channels" &&
      response.request().method() === "GET"
  );
  await page.goto("/");
  await channelsLoaded;
};

/** Clicking the agent in the sidebar is the only way in - no deep link. */
const openAgentRail = async (page: Page): Promise<Locator> => {
  await gotoWorkspace(page);
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("button", { name: `Open ${AGENT_NAME}'s profile` })
    .click();

  const rail = railOf(page);
  await expect(rail.getByText(AGENT_NAME)).toBeVisible();
  return rail;
};

const openTab = async (rail: Locator, name: string): Promise<void> => {
  await rail.getByRole("tab", { name }).click();
  await expect(rail.getByRole("tab", { name })).toHaveAttribute(
    "aria-selected",
    "true"
  );
};

test.describe.configure({ mode: "serial" });

test("creates an agent and opens its screen in the right rail", async ({
  page,
}) => {
  await gotoWorkspace(page);

  await page.getByRole("button", { exact: true, name: "Create" }).click();
  await page.getByRole("button", { exact: true, name: "New agent" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(AGENT_NAME);
  await dialog.getByLabel("Soul").fill(AGENT_SOUL);
  await dialog.getByLabel("Instructions").fill("Keep notes on its computer.");
  await dialog.getByRole("button", { name: "Create agent" }).click();

  const rail = railOf(page);
  await expect(rail.getByText(AGENT_NAME)).toBeVisible();

  // Screen is the tab the rail opens on.
  await expect(rail.getByRole("tab", { name: "Screen" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(rail.getByTestId("agent-screen")).toBeVisible();

  // Nothing has been browsed or run, and this deployment may have no browser at
  // all: either way the tab degrades to a state that says so.
  await expect(
    rail
      .getByTestId("agent-screen-empty")
      .or(rail.getByTestId("agent-screen-error"))
  ).toBeVisible();

  // The profile the rail used to show is a tab of its own now.
  await openTab(rail, "Profile");
  await expect(rail.getByText(AGENT_SOUL)).toBeVisible();
  await expect(rail.getByRole("button", { name: "Edit" })).toBeVisible();
});

test("uploads a file into the agent's computer and previews it", async ({
  page,
}) => {
  const rail = await openAgentRail(page);
  await openTab(rail, "Files");

  // A computer nobody has written to yet is empty, not broken.
  await expect(rail.getByTestId("agent-files-empty")).toBeVisible();

  await rail.getByTestId("agent-file-upload").setInputFiles({
    buffer: Buffer.from(FILE_BODY, "utf8"),
    mimeType: "text/plain",
    name: FILE_NAME,
  });

  const row = rail.getByRole("button", { name: FILE_NAME });
  await expect(row).toBeVisible();

  await row.click();
  const preview = rail.getByTestId("agent-file-preview");
  await expect(preview).toBeVisible();
  await expect(preview.getByText(FILE_BODY)).toBeVisible();
});

test("lists the upload in the activity tab", async ({ page }) => {
  const rail = await openAgentRail(page);
  await openTab(rail, "Activity");

  const feed = rail.getByTestId("agent-activity-feed");
  await expect(feed.getByText(`/${FILE_NAME}`)).toBeVisible();
  await expect(feed.getByText("computer.write")).toBeVisible();
});
