import { Buffer } from "node:buffer";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { BASE_URL, STORAGE_STATE } from "../playwright.config";

/**
 * Phase 1 acceptance script (docs/plan.md 1d), driven end to end: create an
 * agent, create a channel with it, post a mention plus an image, reply in a
 * thread, watch a message arrive live in a second browser, and open the agent
 * rail. Every name carries a run id so repeated runs never collide with data
 * left behind by earlier ones.
 */

const RUN_ID = Date.now().toString(36);
const AGENT_NAME = `SmokeAgent${RUN_ID}`;
const AGENT_SOUL = `Calm, decisive, allergic to busywork (${RUN_ID}).`;
const AGENT_INSTRUCTIONS = "Triage requests and report back in-thread.";
const CHANNEL_NAME = `smoke-${RUN_ID}`;
const MESSAGE_BODY = `hello @${AGENT_NAME} from smoke ${RUN_ID}`;
const REPLY_BODY = `threaded reply ${RUN_ID}`;
const LIVE_BODY = `live update ${RUN_ID}`;
const IMAGE_FILENAME = `smoke-${RUN_ID}.png`;
const LIVE_UPDATE_TIMEOUT_MS = 20_000;

/** A 1x1 red PNG - enough for the browser to decode and lay out. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mPU+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const conversationOf = (page: Page): Locator =>
  page.getByTestId("conversation");

/** The sidebar row that opens a channel; also the "it exists" assertion. */
const channelRow = (page: Page, name: string): Locator =>
  page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("button", { exact: true, name });

/**
 * Clerk remounts the whole tree once it resolves the session (its provider keys
 * children on the session id), which wipes any component state a click set up
 * before that. The workspace only lists channels once Clerk reports a signed-in
 * user, so that request is the signal that the final tree is mounted.
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

const openSidebarMenu = async (page: Page, item: string): Promise<void> => {
  await page.getByRole("button", { exact: true, name: "Create" }).click();
  await page.getByRole("button", { exact: true, name: item }).click();
};

const SOCKET_OPEN_FLAG = "__agentumChannelSocketOpen";

/**
 * The channel room fans out live and never replays, so a message posted before
 * the observer's socket finished its handshake would be missed for a legitimate
 * reason. Flagging the `open` event makes the wait deterministic instead of
 * relying on the socket usually winning the race.
 */
const trackChannelSocket = async (page: Page): Promise<void> => {
  await page.addInitScript((flag) => {
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener("open", () => {
          Reflect.set(window, flag, true);
        });
      }
    };
  }, SOCKET_OPEN_FLAG);
};

const waitForChannelSocket = (page: Page): Promise<unknown> =>
  page.waitForFunction(
    (flag) => Reflect.get(window, flag) === true,
    SOCKET_OPEN_FLAG
  );

const openChannel = async (page: Page, name: string): Promise<void> => {
  await gotoWorkspace(page);
  await channelRow(page, name).click();
  await expect(
    conversationOf(page).getByRole("heading", { name: `# ${name}` })
  ).toBeVisible();
};

test.describe.configure({ mode: "serial" });

test("creates an agent and a channel, posts a mention with an image, and replies in a thread", async ({
  page,
}) => {
  await gotoWorkspace(page);

  // --- create the agent ----------------------------------------------------
  await openSidebarMenu(page, "New agent");
  const agentDialog = page.getByRole("dialog");
  await agentDialog.getByLabel("Name").fill(AGENT_NAME);
  await agentDialog.getByLabel("Soul").fill(AGENT_SOUL);
  await agentDialog.getByLabel("Instructions").fill(AGENT_INSTRUCTIONS);
  await agentDialog.getByRole("button", { name: "Create agent" }).click();

  const sidebar = page.getByRole("navigation", { name: "Workspace" });
  await expect(
    sidebar.getByRole("button", { exact: true, name: AGENT_NAME })
  ).toBeVisible();

  // --- create the channel with that agent as a member ----------------------
  await openSidebarMenu(page, "New channel");
  const channelDialog = page.getByRole("dialog");
  await channelDialog.getByLabel("Name").fill(CHANNEL_NAME);
  await channelDialog.getByRole("checkbox", { name: AGENT_NAME }).check();
  await channelDialog.getByRole("button", { name: "Create channel" }).click();

  await expect(channelRow(page, CHANNEL_NAME)).toBeVisible();
  const conversation = conversationOf(page);
  await expect(
    conversation.getByRole("heading", { name: `# ${CHANNEL_NAME}` })
  ).toBeVisible();

  // --- post a message that mentions the agent and carries an image ---------
  await conversation.locator('input[type="file"]').setInputFiles({
    buffer: Buffer.from(PNG_BASE64, "base64"),
    mimeType: "image/png",
    name: IMAGE_FILENAME,
  });
  await expect(conversation.getByText(IMAGE_FILENAME)).toBeVisible();

  await conversation
    .getByPlaceholder(`Message # ${CHANNEL_NAME}`)
    .fill(MESSAGE_BODY);
  await conversation.getByRole("button", { name: "Send" }).click();

  const posted = conversation
    .getByRole("article")
    .filter({ hasText: MESSAGE_BODY });
  await expect(posted.getByText(MESSAGE_BODY)).toBeVisible();

  const image = posted.getByRole("img", { name: IMAGE_FILENAME });
  await expect(image).toBeVisible();
  await expect
    .poll(() =>
      image.evaluate((element: HTMLImageElement) => element.naturalWidth)
    )
    .toBeGreaterThan(0);

  // --- reply in a thread ---------------------------------------------------
  await posted.getByRole("button", { name: "Reply" }).click();
  const threadPanel = page.getByTestId("thread-panel");
  await expect(threadPanel.getByText(MESSAGE_BODY)).toBeVisible();

  await threadPanel.getByPlaceholder("Reply in thread").fill(REPLY_BODY);
  await threadPanel.getByRole("button", { name: "Send" }).click();

  await expect(threadPanel.getByText(REPLY_BODY)).toBeVisible();
  await expect(posted.getByRole("button", { name: "1 reply" })).toBeVisible();
});

test("shows the agent profile in the right rail", async ({ page }) => {
  await openChannel(page, CHANNEL_NAME);

  // The channel header renders one avatar per agent member; clicking it is the
  // "click an agent avatar" step of the acceptance script.
  await conversationOf(page)
    .getByRole("button", { name: `Open ${AGENT_NAME}'s profile` })
    .click();

  const rail = page.getByTestId("agent-rail");
  await expect(rail.getByText(AGENT_NAME)).toBeVisible();
  await expect(rail.getByText(AGENT_SOUL)).toBeVisible();
});

test("delivers a new message to a second browser without a reload", async ({
  browser,
  page,
}) => {
  await openChannel(page, CHANNEL_NAME);

  const observer = await browser.newContext({
    baseURL: BASE_URL,
    storageState: STORAGE_STATE,
  });
  try {
    const observerPage = await observer.newPage();
    await trackChannelSocket(observerPage);
    await openChannel(observerPage, CHANNEL_NAME);
    await waitForChannelSocket(observerPage);
    // Nothing below reloads or re-navigates the observer: the message has to
    // arrive over the channel socket.
    const observed = conversationOf(observerPage).getByText(LIVE_BODY);
    await expect(observed).toHaveCount(0);

    const conversation = conversationOf(page);
    await conversation
      .getByPlaceholder(`Message # ${CHANNEL_NAME}`)
      .fill(LIVE_BODY);
    await conversation.getByRole("button", { name: "Send" }).click();
    await expect(conversation.getByText(LIVE_BODY)).toBeVisible();

    await expect(observed).toBeVisible({ timeout: LIVE_UPDATE_TIMEOUT_MS });
  } finally {
    await observer.close();
  }
});
