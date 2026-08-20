import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  OPEN_TOOLS,
  SECURE_TOOL_NAME,
  type StubHandle,
  startStubServers,
} from "./stub-mcp-server";

/**
 * Phase 4 acceptance script (docs/plan-connectors-skills.md 4d/4e), driven end
 * to end against the stub MCP servers in `stub-mcp-server.ts`: add a server
 * that wants nothing, one that wants OAuth (through the popup), and one that
 * leaves no way in but a pasted token; assign and unassign a connector in the
 * agent's settings; then disable and remove one.
 *
 * Names and stub paths carry a run id: `connectors.url` is unique and the local
 * D1 file outlives the run that wrote it.
 */

const RUN_ID = Date.now().toString(36);
const OPEN_NAME = `OpenStub${RUN_ID}`;
const OAUTH_NAME = `OauthStub${RUN_ID}`;
const BEARER_NAME = `BearerStub${RUN_ID}`;
const AGENT_NAME = `ConnAgent${RUN_ID}`;
/** The popup round trip is several server-to-server hops behind one click. */
const OAUTH_TIMEOUT_MS = 30_000;

const CONNECTED = /connected/;
const DISABLED = /disabled/;
const TWO_TOOLS = /Reached the server: 2 tools/;
const BEARER_WARNING = /usually want an OAuth access token/;
const NONE_ASSIGNED = /None assigned/;
const NEXT_SESSION = /take effect on the agent's next session/;
const NO_CONNECTORS_ASSIGNED = /0 of 19 connectors/;
const ONE_CONNECTOR_ASSIGNED = /1 of 19 connectors/;
const VAULT_WARNING = /archived in the Anthropic vault/;

let stubs: StubHandle;

test.beforeAll(async () => {
  stubs = await startStubServers(RUN_ID);
});

test.afterAll(async () => {
  await stubs.close();
});

const sidebarOf = (page: Page): Locator =>
  page.getByRole("navigation", { name: "Workspace" });

const connectorsNavOf = (page: Page): Locator =>
  page.getByRole("navigation", { name: "Connectors" });

const railOf = (page: Page): Locator => page.getByTestId("agent-rail");

/**
 * Clerk remounts the tree once it resolves the session, wiping state a click
 * set up before that; the connector list is only requested for a signed-in
 * user, so that response is the signal that the final tree is mounted.
 */
const gotoWorkspace = async (page: Page): Promise<void> => {
  const connectorsLoaded = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/connectors" &&
      response.request().method() === "GET"
  );
  await page.goto("/");
  await connectorsLoaded;
};

/** Opens the sidebar's add-connector dialog and fills its first step. */
const startAdd = async (
  page: Page,
  input: { name: string; url: string }
): Promise<Locator> => {
  await sidebarOf(page).getByRole("button", { name: "Add connector" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Server URL").fill(input.url);
  await dialog.getByLabel("Name (optional)").fill(input.name);
  return dialog;
};

const sidebarRow = (page: Page, name: string): Locator =>
  sidebarOf(page).getByRole("link", { name });

/**
 * The row that opens a connector, in whichever nav is on screen: the workspace
 * sidebar lists them, and so does the connectors page you land on.
 */
const connectorLink = (page: Page, name: string): Locator =>
  sidebarRow(page, name).or(connectorsNavOf(page).getByRole("link", { name }));

const openConnector = async (page: Page, name: string): Promise<void> => {
  await connectorLink(page, name).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
};

test.describe.configure({ mode: "serial" });

test("adds a server that needs no credentials and lists its tools", async ({
  page,
}) => {
  await gotoWorkspace(page);

  const dialog = await startAdd(page, {
    name: OPEN_NAME,
    url: stubs.urls.openMcp,
  });
  await dialog.getByRole("button", { name: "Add connector" }).click();

  // Rung 1 of the ladder: the probe succeeded, so there is nothing to ask and
  // the dialog closes on its own.
  await expect(dialog).toBeHidden();
  await expect(sidebarRow(page, OPEN_NAME)).toBeVisible();

  await openConnector(page, OPEN_NAME);
  await expect(page.getByTestId("connector-status")).toHaveText(CONNECTED);

  const tools = page.getByTestId("connector-tools");
  await Promise.all(
    OPEN_TOOLS.map((tool) => expect(tools.getByText(tool.name)).toBeVisible())
  );

  // Re-probing on demand is the detail view's "is it still there" button.
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByText(TWO_TOOLS)).toBeVisible();
});

test("completes the OAuth popup flow and comes back connected", async ({
  page,
}) => {
  await gotoWorkspace(page);

  const dialog = await startAdd(page, {
    name: OAUTH_NAME,
    url: stubs.urls.secureMcp,
  });

  // The popup is opened blank inside the click and navigated once the server
  // hands back an authorize URL, so the event fires on the click itself.
  const popupOpened = page.waitForEvent("popup");
  await dialog.getByRole("button", { name: "Add connector" }).click();
  const popup = await popupOpened;

  // The stub authorization server redirects straight to our callback, which
  // completes the exchange and closes the popup - so the assertion is on the
  // dialog going away, not on anything inside the popup.
  await expect(dialog).toBeHidden({ timeout: OAUTH_TIMEOUT_MS });
  await popup.close().catch(() => {
    // Already closed by the callback page.
  });

  await expect(sidebarRow(page, OAUTH_NAME)).toBeVisible();
  await openConnector(page, OAUTH_NAME);
  await expect(page.getByTestId("connector-status")).toHaveText(CONNECTED);
  await expect(
    page.getByTestId("connector-tools").getByText(SECURE_TOOL_NAME)
  ).toBeVisible();
});

test("falls back to a pasted bearer token when there is no OAuth to find", async ({
  page,
}) => {
  await gotoWorkspace(page);

  const dialog = await startAdd(page, {
    name: BEARER_NAME,
    url: stubs.urls.bearerMcp,
  });
  await dialog.getByRole("button", { name: "Add connector" }).click();

  // Rung 6: the 401 carried no metadata and the origin serves none, so the
  // ladder runs out and the dialog asks for a token - with the warning that an
  // API key is usually the wrong thing to paste.
  await expect(dialog.getByText(BEARER_WARNING)).toBeVisible();
  await dialog.getByLabel("Bearer token").fill(`stub-pasted-${RUN_ID}`);
  await dialog.getByRole("button", { name: "Save token" }).click();

  await expect(dialog).toBeHidden();
  await openConnector(page, BEARER_NAME);
  await expect(page.getByTestId("connector-status")).toHaveText(CONNECTED);
});

test("assigns and unassigns a connector in the agent's settings", async ({
  page,
}) => {
  await gotoWorkspace(page);

  await page.getByRole("button", { exact: true, name: "Create" }).click();
  await page.getByRole("button", { exact: true, name: "New agent" }).click();
  const newAgent = page.getByRole("dialog");
  await newAgent.getByLabel("Name").fill(AGENT_NAME);
  await newAgent.getByLabel("Soul").fill("Uses connectors.");
  await newAgent.getByLabel("Instructions").fill("Call the stub's tools.");
  await newAgent.getByRole("button", { name: "Create agent" }).click();

  const rail = railOf(page);
  await expect(rail.getByText(AGENT_NAME)).toBeVisible();
  await rail.getByRole("tab", { name: "Profile" }).click();

  // No connector yet, so the chips say so rather than being absent.
  await expect(rail.getByText(NONE_ASSIGNED)).toBeVisible();

  await rail.getByRole("button", { name: "Edit" }).click();
  const settings = page.getByRole("dialog");
  await settings.getByRole("tab", { name: "Connectors" }).click();

  await expect(settings.getByTestId("cap-note")).toHaveText(
    NO_CONNECTORS_ASSIGNED
  );
  await expect(settings.getByText(NEXT_SESSION)).toBeVisible();

  // `click`, not `check`: the box is controlled by what the server has stored,
  // so it only ticks once the assignment has been written and re-read.
  const openBox = settings.getByRole("checkbox", { name: OPEN_NAME });
  await openBox.click();
  await expect(openBox).toBeChecked();
  await expect(settings.getByTestId("cap-note")).toHaveText(
    ONE_CONNECTOR_ASSIGNED
  );

  // The rail is the plan's "health at the agent": a chip per assignment.
  await settings.getByRole("button", { name: "Close" }).click();
  await expect(
    rail.getByTestId("agent-connector-chips").getByText(OPEN_NAME)
  ).toBeVisible();

  // And unassigning takes it back off.
  await rail.getByRole("button", { name: "Edit" }).click();
  await settings.getByRole("tab", { name: "Connectors" }).click();
  const assignedBox = settings.getByRole("checkbox", { name: OPEN_NAME });
  await expect(assignedBox).toBeChecked();
  await assignedBox.click();
  await expect(assignedBox).not.toBeChecked();
  await expect(settings.getByTestId("cap-note")).toHaveText(
    NO_CONNECTORS_ASSIGNED
  );
  await settings.getByRole("button", { name: "Close" }).click();
  await expect(rail.getByText(NONE_ASSIGNED)).toBeVisible();
});

test("disables a connector, then removes one", async ({ page }) => {
  await gotoWorkspace(page);
  // The no-auth connector is the one whose re-enabled state is unambiguous:
  // re-enabling restores what the credential implies, and it needs none.
  await openConnector(page, OPEN_NAME);

  await page.getByRole("button", { name: "Disable" }).click();
  await expect(page.getByTestId("connector-status")).toHaveText(DISABLED);

  // Re-enabling is the same button, which is what makes the state reversible
  // from the one place it is shown.
  await page.getByRole("button", { name: "Enable" }).click();
  await expect(page.getByTestId("connector-status")).toHaveText(CONNECTED);

  await openConnector(page, BEARER_NAME);
  await page.getByRole("button", { name: "Remove" }).click();
  const confirm = page.getByRole("dialog");
  await expect(confirm.getByText(VAULT_WARNING)).toBeVisible();
  await confirm.getByRole("button", { name: "Remove connector" }).click();

  // Gone from the directory it was listed in, and from the sidebar.
  await expect(connectorsNavOf(page).getByText(BEARER_NAME)).toHaveCount(0);
  await gotoWorkspace(page);
  await expect(sidebarRow(page, BEARER_NAME)).toHaveCount(0);
  await expect(sidebarRow(page, OPEN_NAME)).toBeVisible();
});
