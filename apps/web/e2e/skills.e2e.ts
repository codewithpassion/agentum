import { expect, type Locator, type Page, test } from "@playwright/test";

/**
 * Phase 5 acceptance script (docs/plan-connectors-skills.md 5e/5f): write a
 * skill with a script file, publish a second version with a changelog, assign
 * it to an agent, pin that agent to a version, then take it back off.
 *
 * The suite runs with the Anthropic kill switch on (`--mode e2e`), so every
 * skill here stays `unsynced` - which is exactly the state the UI has to keep
 * usable, and is asserted rather than worked around.
 *
 * Names carry a run id: slugs are unique and the local D1 file outlives the run
 * that wrote it.
 */

const RUN_ID = Date.now().toString(36);
const SLUG = `e2e-skill-${RUN_ID}`;
const DESCRIPTION = `Greets the workspace, run ${RUN_ID}.`;
const SCRIPT_PATH = "scripts/run.sh";
const SCRIPT_LABEL = `${SCRIPT_PATH} content`;
const FIRST_SCRIPT = `echo "hello from ${RUN_ID}"`;
const SECOND_SCRIPT = `echo "fixed in ${RUN_ID}"`;
const CHANGELOG = "Fixed: the greeting said hello to nobody.";
const AGENT_NAME = `SkillAgent${RUN_ID}`;

const NOT_SYNCED = /not synced yet/;
const UNSYNCED_FLAG = /reaches the agent once synced/;
const NO_SKILLS_ASSIGNED = /0 of 20 skills/;
const ONE_SKILL_ASSIGNED = /1 of 20 skills/;
const NONE_ON_RAIL = /No skills yet\. Add one from Edit/;
const DELETE_WARNING = /every version is deleted at Anthropic/;
const INVALID_SLUG = /is not a valid skill slug/;
const VIEWING_V1_OF_1 = /Viewing v1 of 1/;
const VIEWING_V1_OF_2 = /Viewing v1 of 2/;
const VIEWING_V2_OF_2 = /Viewing v2 of 2/;
const V1_ROW = /^v1/;
const V2_ROW = /^v2/;
const NAME_FIELD = new RegExp(`name: ${SLUG}`);
const DESCRIPTION_FIELD = new RegExp(DESCRIPTION);

const sidebarOf = (page: Page): Locator =>
  page.getByRole("navigation", { name: "Workspace" });

const skillsNavOf = (page: Page): Locator =>
  page.getByRole("navigation", { name: "Skills" });

const railOf = (page: Page): Locator => page.getByTestId("agent-rail");

const WORKSPACE_PATH = /^\/w\/[^/]+/;
/** The workspace's own skills API - not the `/w/:slug/skills` page of it. */
const SKILLS_API = /^\/api\/w\/[^/]+\/skills$/;

/**
 * Clerk remounts the tree once it resolves the session, wiping whatever was
 * typed into the tree it replaces. The skills list answering is what says the
 * screen is up, but the remount lands about a second later - so the wait ends
 * on the quiet after Clerk's own round trips, not on the first list.
 */
const gotoAndSettle = async (page: Page, path: string): Promise<void> => {
  const skillsLoaded = page.waitForResponse(
    (response) =>
      SKILLS_API.test(new URL(response.url()).pathname) &&
      response.request().method() === "GET"
  );
  await page.goto(path);
  await skillsLoaded;
  await page.waitForLoadState("networkidle");
};

/** The workspace `/` resolved to, kept for the deep links that follow. */
let workspacePath: string | null = null;

/**
 * Skills are addressed under a workspace now (`/w/:slug/skills`). Which one `/`
 * lands in is the browser's business - the last one visited, or the first the
 * signed-in user belongs to - so the suite reads the slug back off the URL
 * instead of naming a workspace of its own.
 */
const openWorkspace = async (page: Page): Promise<string> => {
  if (workspacePath) {
    return workspacePath;
  }
  await gotoAndSettle(page, "/");
  const landed = new URL(page.url()).pathname.match(WORKSPACE_PATH)?.[0];
  if (!landed) {
    throw new Error(`Expected / to open a workspace, landed on ${page.url()}`);
  }
  workspacePath = landed;
  return landed;
};

/** Opens one of the skills screens of the workspace `/` resolves to. */
const gotoInWorkspace = async (page: Page, path: string): Promise<void> => {
  const workspace = await openWorkspace(page);
  await gotoAndSettle(page, `${workspace}${path}`);
};

test.describe.configure({ mode: "serial" });

test("refuses an invalid slug in the words the server used", async ({
  page,
}) => {
  await gotoInWorkspace(page, "/skills?new=true");

  // Nothing is validated in the browser, so what the author reads is the rule
  // that actually refused the write - and no skill is left behind by it.
  await page.getByLabel("Slug", { exact: true }).fill("Bad Slug");
  await page.getByRole("button", { name: "Create skill" }).click();

  await expect(page.getByRole("alert")).toContainText(INVALID_SLUG);
});

test("writes a skill with a script and lists it in the directory", async ({
  page,
}) => {
  await gotoInWorkspace(page, "");

  await sidebarOf(page).getByRole("link", { name: "New skill" }).click();

  await page.getByLabel("Slug", { exact: true }).fill(SLUG);
  await page.getByLabel("Description", { exact: true }).fill(DESCRIPTION);

  // The slug and the frontmatter name are one value - the API refuses a
  // version where they differ - so the form keeps SKILL.md in step.
  const document = page.getByLabel("SKILL.md content", { exact: true });
  await expect(document).toHaveValue(NAME_FIELD);
  await expect(document).toHaveValue(DESCRIPTION_FIELD);

  await page.getByLabel("Add a file", { exact: true }).fill(SCRIPT_PATH);
  await page.getByRole("button", { name: "Add file" }).click();
  await page.getByLabel(SCRIPT_LABEL, { exact: true }).fill(FIRST_SCRIPT);

  await page.getByRole("button", { name: "Create skill" }).click();

  // Landed on the skill's own page, with both files and the rendered SKILL.md.
  await expect(
    page.getByRole("heading", { exact: true, level: 2, name: SLUG })
  ).toBeVisible();
  await expect(page.getByTestId("skill-version")).toHaveText(VIEWING_V1_OF_1);
  await expect(page.getByTestId("skill-sync-status")).toHaveText(NOT_SYNCED);
  const files = page.getByTestId("skill-files");
  await expect(files.getByText("SKILL.md")).toBeVisible();
  await expect(files.getByText(SCRIPT_PATH)).toBeVisible();
  // The rendered SKILL.md is the file's prose - its frontmatter is metadata,
  // not a heading, which is what markdown would otherwise make of it.
  const rendered = page.getByTestId("skill-document");
  await expect(
    rendered.getByRole("heading", { level: 2, name: "When to use this" })
  ).toBeVisible();
  await expect(rendered).not.toContainText(DESCRIPTION);

  // A file's bytes are readable without leaving the page.
  await files
    .getByRole("listitem")
    .filter({ hasText: SCRIPT_PATH })
    .getByRole("button", { name: "View" })
    .click();
  await expect(page.getByTestId("skill-file-content")).toHaveText(FIRST_SCRIPT);

  // And the directory lists it with everything the plan asks for.
  await gotoInWorkspace(page, "/skills");
  const row = page
    .getByTestId("skill-directory")
    .getByRole("link", { name: SLUG });
  await expect(row).toContainText(DESCRIPTION);
  await expect(row).toContainText("v1");
  await expect(row).toContainText("by You");
  await expect(
    skillsNavOf(page).getByRole("link", { name: SLUG })
  ).toBeVisible();
});

test("publishes a second version and keeps both in the history", async ({
  page,
}) => {
  await gotoInWorkspace(page, `/skills/${SLUG}`);

  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Changelog", { exact: true }).fill(CHANGELOG);
  // The editor loads the version's files, so this replaces what v1 shipped.
  await expect(page.getByLabel(SCRIPT_LABEL, { exact: true })).toHaveValue(
    FIRST_SCRIPT
  );
  await page.getByLabel(SCRIPT_LABEL, { exact: true }).fill(SECOND_SCRIPT);
  await page.getByRole("button", { name: "Save new version" }).click();

  await expect(page.getByTestId("skill-version")).toHaveText(VIEWING_V2_OF_2);
  const history = page.getByTestId("skill-versions");
  await expect(history.getByRole("button", { name: V2_ROW })).toContainText(
    CHANGELOG
  );
  await expect(history.getByRole("button", { name: V1_ROW })).toContainText(
    "Created."
  );
  await expect(history.getByRole("button", { name: V1_ROW })).toContainText(
    "You"
  );

  // An older version is readable, and v1's file is still exactly what it was.
  await history.getByRole("button", { name: V1_ROW }).click();
  await expect(page.getByTestId("skill-version")).toHaveText(VIEWING_V1_OF_2);
  await page
    .getByTestId("skill-files")
    .getByRole("listitem")
    .filter({ hasText: SCRIPT_PATH })
    .getByRole("button", { name: "View" })
    .click();
  await expect(page.getByTestId("skill-file-content")).toHaveText(FIRST_SCRIPT);

  await page.getByRole("button", { name: "Back to latest" }).click();
  await expect(page.getByTestId("skill-version")).toHaveText(VIEWING_V2_OF_2);
});

test("assigns the skill to an agent, pins a version, then unassigns", async ({
  page,
}) => {
  await gotoInWorkspace(page, "");

  await page.getByRole("button", { exact: true, name: "Create" }).click();
  await page.getByRole("button", { exact: true, name: "New agent" }).click();
  const newAgent = page.getByRole("dialog");
  await newAgent.getByLabel("Name").fill(AGENT_NAME);
  await newAgent.getByLabel("Soul").fill("Uses skills.");
  await newAgent.getByLabel("Instructions").fill("Run the skill's script.");
  await newAgent.getByRole("button", { name: "Create agent" }).click();

  const rail = railOf(page);
  await expect(rail.getByText(AGENT_NAME)).toBeVisible();
  await rail.getByRole("tab", { name: "Profile" }).click();
  await expect(rail.getByText(NONE_ON_RAIL)).toBeVisible();

  await rail.getByRole("button", { name: "Edit" }).click();
  const settings = page.getByRole("dialog");
  await settings.getByRole("tab", { name: "Skills" }).click();

  await expect(settings.getByTestId("skills-cap-note")).toHaveText(
    NO_SKILLS_ASSIGNED
  );
  // The kill switch leaves every skill unsynced; it is pickable, and says so.
  await expect(settings.getByText(UNSYNCED_FLAG).first()).toBeVisible();

  // `click`, not `check`: the box is controlled by what the server has stored,
  // so it only ticks once the assignment has been written and re-read.
  const box = settings.getByRole("checkbox", { name: SLUG });
  await box.click();
  await expect(box).toBeChecked();
  await expect(settings.getByTestId("skills-cap-note")).toHaveText(
    ONE_SKILL_ASSIGNED
  );

  // Tracking latest is the default; pinning is the escape hatch.
  const version = settings.getByLabel(`Version of ${SLUG}`, { exact: true });
  await expect(version).toHaveValue("latest");
  await version.selectOption("1");
  await expect(version).toHaveValue("1");

  await settings.getByRole("button", { name: "Close" }).click();
  const chip = rail.getByTestId("agent-skill-chips").getByRole("link", {
    name: SLUG,
  });
  await expect(chip).toContainText("v1");

  // And unassigning takes it back off.
  await rail.getByRole("button", { name: "Edit" }).click();
  await settings.getByRole("tab", { name: "Skills" }).click();
  const assigned = settings.getByRole("checkbox", { name: SLUG });
  await expect(assigned).toBeChecked();
  await assigned.click();
  await expect(assigned).not.toBeChecked();
  await expect(settings.getByTestId("skills-cap-note")).toHaveText(
    NO_SKILLS_ASSIGNED
  );
  await settings.getByRole("button", { name: "Close" }).click();
  await expect(rail.getByText(NONE_ON_RAIL)).toBeVisible();
});

test("deletes the skill after saying what deleting means", async ({ page }) => {
  await gotoInWorkspace(page, `/skills/${SLUG}`);

  await page.getByRole("button", { name: "Delete" }).click();
  const confirm = page.getByRole("dialog");
  await expect(confirm.getByText(DELETE_WARNING)).toBeVisible();
  await confirm.getByRole("button", { name: "Delete skill" }).click();

  await expect(skillsNavOf(page).getByRole("link", { name: SLUG })).toHaveCount(
    0
  );
  await gotoInWorkspace(page, "");
  await expect(sidebarOf(page).getByRole("link", { name: SLUG })).toHaveCount(
    0
  );
});
