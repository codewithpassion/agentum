import { expect, type Locator, type Page, test } from "@playwright/test";

/**
 * Phase M4 acceptance (docs/plan-model-config.md): the two model pickers the
 * feature adds, driven by clicking. Both are round-trips rather than "the save
 * did not error" - the value is read back after a reload, which is the only way
 * to tell a stored model from one the form is still holding in memory.
 *
 * The ids are the catalog's (`modules/anthropic/config`) and are written out
 * here on purpose: a rename there should fail this test, not be followed by it.
 */

const RUN_ID = Date.now().toString(36);
const AGENT_NAME = `ModelAgent${RUN_ID}`;
const CHANNEL_NAME = `model-${RUN_ID}`;
const ROUTINE_NAME = `Model routine ${RUN_ID}`;
const OPUS_ID = "claude-opus-5";
const OPUS_LABEL = "Opus 5";
/** Unset is the empty string in the DOM, and null on the wire. */
const DEFAULT_VALUE = "";

const railOf = (page: Page): Locator => page.getByTestId("agent-rail");

/**
 * Clerk remounts the tree once it resolves the session, which wipes state a
 * click set up before that; the workspace's channel request is the signal that
 * the final tree is mounted, so the sidebar can be clicked safely.
 */
const gotoWorkspace = async (page: Page): Promise<void> => {
  const channelsLoaded = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith("/channels") &&
      response.request().method() === "GET"
  );
  await page.goto("/");
  await channelsLoaded;
};

/** A fresh load, then into the agent's edit dialog - never cached form state. */
const reopenAgentDialog = async (page: Page): Promise<Locator> => {
  await gotoWorkspace(page);
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("button", { name: `Open ${AGENT_NAME}'s profile` })
    .click();

  const rail = railOf(page);
  await expect(rail.getByText(AGENT_NAME)).toBeVisible();
  await rail.getByRole("tab", { name: "Profile" }).click();
  await rail.getByRole("button", { name: "Edit" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("agent-model")).toBeVisible();
  return dialog;
};

const gotoRoutines = async (page: Page): Promise<void> => {
  await gotoWorkspace(page);
  await page.getByRole("link", { name: "Routines" }).click();
  await expect(
    page.getByRole("navigation", { name: "Routines" })
  ).toBeVisible();
};

test.describe.configure({ mode: "serial" });

test("an agent created with a model keeps it across a reload", async ({
  page,
}) => {
  await gotoWorkspace(page);

  await page.getByRole("button", { exact: true, name: "Create" }).click();
  await page.getByRole("button", { exact: true, name: "New agent" }).click();

  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(AGENT_NAME);
  await dialog.getByLabel("Soul").fill(`Runs on Opus (${RUN_ID}).`);
  await dialog.getByLabel("Instructions").fill("Think hard, answer briefly.");

  // A new agent starts on the workspace default, named after the default model.
  const model = dialog.getByTestId("agent-model");
  await expect(model).toHaveValue(DEFAULT_VALUE);
  await expect(model.getByRole("option", { selected: true })).toHaveText(
    "Workspace default (Sonnet 5)"
  );

  await model.selectOption(OPUS_ID);
  await dialog.getByRole("button", { name: "Create agent" }).click();

  await expect(railOf(page).getByText(AGENT_NAME)).toBeVisible();

  const reopened = await reopenAgentDialog(page);
  await expect(reopened.getByTestId("agent-model")).toHaveValue(OPUS_ID);
});

test("an agent can be put back on the workspace default", async ({ page }) => {
  const dialog = await reopenAgentDialog(page);
  await dialog.getByTestId("agent-model").selectOption(DEFAULT_VALUE);
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toBeHidden();

  const reopened = await reopenAgentDialog(page);
  await expect(reopened.getByTestId("agent-model")).toHaveValue(DEFAULT_VALUE);
});

test("a routine's model round-trips and is shown in its facts", async ({
  page,
}) => {
  // A routine needs somewhere to fire; the agent from the first test is here.
  await gotoWorkspace(page);
  await page.getByRole("button", { exact: true, name: "Create" }).click();
  await page.getByRole("button", { exact: true, name: "New channel" }).click();

  const channelDialog = page.getByRole("dialog");
  await channelDialog.getByLabel("Name").fill(CHANNEL_NAME);
  await channelDialog.getByRole("checkbox", { name: AGENT_NAME }).check();
  await channelDialog.getByRole("button", { name: "Create channel" }).click();
  await expect(channelDialog).toBeHidden();

  await gotoRoutines(page);
  // The empty state offers a second "New routine"; the nav's is always there.
  await page
    .getByRole("navigation", { name: "Routines" })
    .getByRole("button", { name: "New routine" })
    .click();

  await page.getByTestId("routine-name").fill(ROUTINE_NAME);
  await page.getByTestId("routine-agent").selectOption({ label: AGENT_NAME });
  await page
    .getByTestId("routine-channel")
    .selectOption({ label: CHANNEL_NAME });
  await page
    .getByTestId("routine-instructions")
    .fill("Summarise yesterday and flag anything unanswered.");

  // A new routine runs on whatever its agent runs on until told otherwise.
  const model = page.getByTestId("routine-model");
  await expect(model).toHaveValue(DEFAULT_VALUE);
  await expect(model.getByRole("option", { selected: true })).toHaveText(
    "Agent default"
  );
  await model.selectOption(OPUS_ID);

  // The default schedule is daily at 09:00, which always has a run ahead of it.
  await page.getByTestId("routine-save").click();

  // Creating lands on the new routine, whose facts name the model it overrode.
  await expect(page.getByRole("heading", { name: ROUTINE_NAME })).toBeVisible();
  await expect(page.getByTestId("routine-model-fact")).toContainText(
    OPUS_LABEL
  );

  // Editing reopens on the stored model, and clearing it drops the fact again.
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByTestId("routine-model")).toHaveValue(OPUS_ID);

  await page.getByTestId("routine-model").selectOption(DEFAULT_VALUE);
  await page.getByTestId("routine-save").click();

  await expect(page.getByRole("heading", { name: ROUTINE_NAME })).toBeVisible();
  await expect(page.getByTestId("routine-model-fact")).toHaveCount(0);
});
