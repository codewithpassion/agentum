import { Buffer } from "node:buffer";
import { expect, type Locator, type Page, test } from "@playwright/test";

/**
 * Phase 2c acceptance script (docs/plan.md 2c), driven end to end: reach the
 * wiki from the sidebar, create a page, read the rendered markdown, deep-link
 * to a heading, edit the page, and see both revisions in its history. Names
 * carry a run id so repeated runs never collide with earlier data - page slugs
 * are unique, and the local D1 file survives between runs.
 */

const RUN_ID = Date.now().toString(36);
const PAGE_TITLE = `Smoke Wiki ${RUN_ID}`;
const PAGE_SLUG = `smoke-wiki-${RUN_ID}`;
const INTRO = `Written by the smoke suite (${RUN_ID}).`;
const SECTION = "Deep Section";
const SECTION_TEXT = `Anchored content ${RUN_ID}.`;
const EDIT_TEXT = `Edited by the smoke suite ${RUN_ID}.`;
const LINKED_TITLE = `Unwritten ${RUN_ID}`;

/** The hierarchy is in the slug: this page is written as "<folder>/Setup". */
const FOLDER_SLUG = `guides-${RUN_ID}`;
const FOLDER_TITLE = `Guides ${RUN_ID}`;
const NESTED_TITLE = "Setup";
const NESTED_SLUG = `${FOLDER_SLUG}/setup`;
const NESTED_BODY = `Nested setup notes (${RUN_ID}).`;
const NESTED_EDIT = `Edited the nested page ${RUN_ID}.`;
const NESTED_URL = new RegExp(`/wiki/${NESTED_SLUG}$`);

/** Long enough that the anchored section starts below the fold. */
const FILLER = Array.from(
  { length: 40 },
  (_, index) => `Filler paragraph ${index} for the ${RUN_ID} smoke page.`
).join("\n\n");

const PAGE_BODY = [
  "# Overview",
  "",
  INTRO,
  "",
  `A link to [[${LINKED_TITLE}]].`,
  "",
  FILLER,
  "",
  `## ${SECTION}`,
  "",
  SECTION_TEXT,
].join("\n");

/** A 1x1 red PNG - enough for the browser to decode and lay out. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mPU+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const ASSET_FILENAME = `wiki-asset-${RUN_ID}.png`;
const ASSET_MARKDOWN = new RegExp(`!\\[${ASSET_FILENAME}]\\(/api/wiki/assets/`);

const MISSING_LINK_CLASS = /wiki-link-missing/;
const SECTION_HASH = /#deep-section$/;
const FIRST_REVISION = /Revision 1/;

const wikiNav = (page: Page): Locator =>
  page.getByRole("navigation", { name: "Wiki pages" });

/**
 * Clerk remounts the tree once it resolves the session, which wipes state a
 * click set up before that; the workspace's channel request is the signal that
 * the final tree is mounted, so the sidebar can be clicked safely.
 */
const openWikiFromSidebar = async (page: Page): Promise<void> => {
  const channelsLoaded = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/channels" &&
      response.request().method() === "GET"
  );
  await page.goto("/");
  await channelsLoaded;

  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("link", { name: "Wiki" })
    .click();
  await expect(wikiNav(page)).toBeVisible();
};

/** Opens the smoke page by clicking its row in the page tree. */
const openSmokePage = async (page: Page): Promise<void> => {
  await openWikiFromSidebar(page);
  await wikiNav(page).getByRole("link", { name: PAGE_TITLE }).click();
  await expect(
    page.getByTestId("wiki-page").getByRole("heading", { name: PAGE_TITLE })
  ).toBeVisible();
};

test.describe.configure({ mode: "serial" });

test("creates a wiki page from the UI and renders its markdown", async ({
  page,
}) => {
  await openWikiFromSidebar(page);

  await wikiNav(page).getByRole("button", { name: "New page" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Title").fill(PAGE_TITLE);
  await dialog.getByRole("button", { name: "Write page" }).click();

  // The dialog opens the editor; the page exists once it is saved.
  const body = page.getByLabel("Body");
  await expect(body).toBeVisible();
  await body.fill(PAGE_BODY);
  await page.getByRole("button", { name: "Save" }).click();

  const article = page.getByTestId("wiki-page");
  await expect(
    article.getByRole("heading", { name: PAGE_TITLE })
  ).toBeVisible();
  await expect(
    article.getByRole("heading", { name: "Overview" })
  ).toBeVisible();
  await expect(article.getByText(INTRO)).toBeVisible();

  // The page is now in the tree, addressed by its generated slug.
  await expect(
    wikiNav(page).getByRole("link", { name: PAGE_TITLE })
  ).toHaveAttribute("href", new RegExp(`/wiki/${PAGE_SLUG}$`));

  // `[[Unwritten ...]]` renders as a link to a page nobody has written yet.
  await expect(article.getByRole("link", { name: LINKED_TITLE })).toHaveClass(
    MISSING_LINK_CLASS
  );
});

test("scrolls and updates the hash when a heading anchor is clicked", async ({
  page,
}) => {
  await openSmokePage(page);

  const article = page.getByTestId("wiki-page");
  const heading = article.getByRole("heading", { name: SECTION });
  await expect(heading).not.toBeInViewport();

  await heading.hover();
  await article
    .getByRole("link", { name: `Link to this section: ${SECTION}` })
    .click();

  await expect(page).toHaveURL(SECTION_HASH);
  await expect(heading).toBeInViewport();
  await expect
    .poll(() =>
      page
        .getByTestId("wiki-body")
        .evaluate((element: HTMLElement) => element.scrollTop)
    )
    .toBeGreaterThan(0);
});

test("edits the page and lists both revisions in its history", async ({
  page,
}) => {
  await openSmokePage(page);

  await page.getByRole("button", { name: "Edit" }).click();
  const body = page.getByLabel("Body");
  await body.fill(`${PAGE_BODY}\n\n${EDIT_TEXT}`);
  await page.getByRole("button", { name: "Save" }).click();

  const article = page.getByTestId("wiki-page");
  await expect(article.getByText(EDIT_TEXT)).toBeVisible();

  await page.getByRole("button", { name: "History" }).click();
  const history = page.getByTestId("wiki-revisions");
  await expect(history.getByRole("listitem")).toHaveCount(2);
  await expect(history.getByText("Revision 2")).toBeVisible();
  await expect(history.getByText("Revision 1")).toBeVisible();

  // The first revision is the page as created, before the edit.
  await history.getByRole("button", { name: FIRST_REVISION }).click();
  await expect(article.getByText(EDIT_TEXT)).toHaveCount(0);
  await expect(article.getByText(INTRO)).toBeVisible();

  // Restoring it writes a third revision rather than rewriting history.
  await page.getByRole("button", { name: "Restore" }).click();
  await expect(article.getByText(EDIT_TEXT)).toHaveCount(0);
  await expect(history.getByRole("listitem")).toHaveCount(3);
});

test("nests a page written with a / in its title", async ({ page }) => {
  await openWikiFromSidebar(page);

  await wikiNav(page).getByRole("button", { name: "New page" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Title").fill(`${FOLDER_TITLE}/${NESTED_TITLE}`);
  await dialog.getByRole("button", { name: "Write page" }).click();

  const body = page.getByLabel("Body");
  await expect(body).toBeVisible();
  await body.fill(NESTED_BODY);
  await page.getByRole("button", { name: "Save" }).click();

  // Only the leaf is the page's name; the rest of the title became its address.
  const article = page.getByTestId("wiki-page");
  await expect(
    article.getByRole("heading", { name: NESTED_TITLE })
  ).toBeVisible();
  await expect(page).toHaveURL(NESTED_URL);

  // The tree grew a folder, with the page inside it.
  const nav = wikiNav(page);
  await expect(
    nav.getByRole("link", { exact: true, name: FOLDER_SLUG })
  ).toHaveAttribute("href", new RegExp(`/wiki/${FOLDER_SLUG}$`));
  // Addressed by path, not by name: "Setup" is only unique inside its folder.
  await expect(nav.locator(`a[href="/wiki/${NESTED_SLUG}"]`)).toHaveText(
    NESTED_TITLE
  );
});

test("shows what is inside a folder that has no page of its own", async ({
  page,
}) => {
  await openWikiFromSidebar(page);
  await wikiNav(page)
    .getByRole("link", { exact: true, name: FOLDER_SLUG })
    .click();

  // A folder is not an unwritten page: it lists what is under it.
  const folder = page.getByTestId("wiki-folder");
  await expect(
    folder.getByRole("heading", { name: FOLDER_SLUG })
  ).toBeVisible();
  await expect(page.getByTestId("wiki-missing")).toHaveCount(0);

  await folder.getByRole("link", { name: NESTED_TITLE }).click();
  const article = page.getByTestId("wiki-page");
  await expect(article.getByText(NESTED_BODY)).toBeVisible();

  // Editing round-trips the nested address through PATCH and the revisions API.
  await page.getByRole("button", { name: "Edit" }).click();
  const body = page.getByLabel("Body");
  await body.fill(`${NESTED_BODY}\n\n${NESTED_EDIT}`);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(article.getByText(NESTED_EDIT)).toBeVisible();
  await expect(page).toHaveURL(NESTED_URL);

  await page.getByRole("button", { name: "History" }).click();
  await expect(
    page.getByTestId("wiki-revisions").getByRole("listitem")
  ).toHaveCount(2);
});

test("follows a wiki-link to an unwritten page and writes it with an asset", async ({
  page,
}) => {
  await openSmokePage(page);

  await page
    .getByTestId("wiki-page")
    .getByRole("link", { name: LINKED_TITLE })
    .click();

  // The target does not exist, so the wiki offers to write it.
  await page
    .getByTestId("wiki-missing")
    .getByRole("button", { name: "Create this page" })
    .click();

  const body = page.getByLabel("Body");
  await expect(body).toBeVisible();
  await body.fill(`Illustrated by ${RUN_ID}.`);

  await page.getByTestId("wiki-file-input").setInputFiles({
    buffer: Buffer.from(PNG_BASE64, "base64"),
    mimeType: "image/png",
    name: ASSET_FILENAME,
  });
  await expect(body).toHaveValue(ASSET_MARKDOWN);

  await page.getByRole("button", { name: "Save" }).click();

  const article = page.getByTestId("wiki-page");
  await expect(
    article.getByRole("heading", { name: LINKED_TITLE })
  ).toBeVisible();
  const image = article.getByRole("img", { name: ASSET_FILENAME });
  await expect(image).toBeVisible();
  await expect
    .poll(() =>
      image.evaluate((element: HTMLImageElement) => element.naturalWidth)
    )
    .toBeGreaterThan(0);
});
