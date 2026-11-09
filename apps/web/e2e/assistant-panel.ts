/** Local acceptance and screenshots. Run with bun e2e/assistant-panel.ts in apps/web.
 * Requires bun run dev and dev login. Seeds local conversation text directly;
 * never sends an assistant message or calls a model. */
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

const MODEL_REQUEST =
  /assistant\.(send|resolveCard)|dictation\.(transcribe|polish)/;
const base = process.env.HM_SERVER ?? "http://localhost:3000";
const evidence =
  process.env.HM_ASSISTANT_EVIDENCE ??
  "/home/roboto/devel/harbourmaster-wt/tmp/WA.3";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { height: 900, width: 1280 },
});
try {
  const assistantRequests: string[] = [];
  page.on("request", (request) => {
    if (
      request.url().includes("/api/trpc/") &&
      request.url().includes("assistant.")
    ) {
      assistantRequests.push(request.url());
    }
    if (MODEL_REQUEST.test(request.url())) {
      throw new Error("This acceptance check must never call a model");
    }
  });
  await page.goto(`${base}/login`);
  await page.getByRole("link", { name: "Dev login (local only)" }).click();
  await page.waitForURL((url) => !url.pathname.includes("login"), {
    timeout: 60_000,
  });
  await expect(
    page.getByRole("button", { exact: true, name: "Assistant" })
  ).toBeVisible();
  const meResponse = await page.request.get(`${base}/api/trpc/me`);
  const me = (await meResponse.json()).result.data as {
    workspaceId: string;
    userId: string;
  };
  await page.goto("about:blank");
  const explorer = `${base}/cdn-cgi/local/explorer/api`;
  const databases = await (
    await page.request.get(`${explorer}/d1/database`)
  ).json();
  const databaseId = databases.result.find(
    (database: { name: string }) => database.name === "DB"
  ).uuid;
  const titles = [
    "Plan the weekly workspace review",
    "Set up a release helper",
    "Review the workspace settings",
  ];
  const ids = titles.map((_, index) => `wa3-panel-${index}`);
  const batch = titles.flatMap((title, index) => {
    const id = ids[index] ?? "";
    return [
      {
        params: [
          id,
          me.workspaceId,
          me.userId,
          title,
          "2026-11-09T00:00:00Z",
          "2026-11-09T00:00:00Z",
        ],
        sql: "INSERT OR REPLACE INTO assistant_conversations (id, workspace_id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      },
      {
        params: [
          `${id}-message`,
          me.workspaceId,
          id,
          JSON.stringify([{ text: title, type: "text" }]),
          "2026-11-09T00:00:00Z",
        ],
        sql: "INSERT OR REPLACE INTO assistant_messages (id, workspace_id, conversation_id, seq, role, content, created_at) VALUES (?, ?, ?, 0, 'user', ?, ?)",
      },
    ];
  });
  const seed = await page.request.post(
    `${explorer}/d1/database/${databaseId}/raw`,
    { data: { batch } }
  );
  expect((await seed.json()).success).toBe(true);

  await page.goto(`${base}/desk?view=board&extra=keep#workspace`);
  await expect(
    page.getByRole("button", { exact: true, name: "Assistant" })
  ).toBeVisible();
  expect(assistantRequests).toHaveLength(0);
  await page.getByRole("button", { exact: true, name: "Assistant" }).click();
  await expect(page).toHaveURL(
    `${base}/desk?view=board&extra=keep&assistant=new#workspace`
  );
  const panel = page.getByRole("dialog");
  await expect(
    panel.getByRole("navigation", { name: "Conversations" })
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Start dictation" })
  ).toBeDisabled();
  const history = await panel.locator("aside").boundingBox();
  const composer = await panel
    .getByLabel("Message", { exact: true })
    .boundingBox();
  expect(
    history && composer && history.x > composer.x + composer.width
  ).toBeTruthy();
  await page.getByRole("button", { exact: true, name: "Assistant" }).click();
  await expect(page).toHaveURL(`${base}/desk?view=board&extra=keep#workspace`);
  await expect(panel).toHaveCount(0);

  await page.goto(`${base}/qa?assistant=${ids[0]}`);
  await expect(
    panel.getByRole("heading", { exact: true, name: titles[0] })
  ).toBeVisible();
  await page.reload();
  await expect(
    panel.getByRole("heading", { exact: true, name: titles[0] })
  ).toBeVisible();
  await panel.getByRole("button", { exact: true, name: titles[1] }).click();
  await expect(page).toHaveURL(`${base}/qa?assistant=${ids[1]}`);
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(`${base}/qa`);

  await page.getByRole("button", { exact: true, name: "Find" }).click();
  await page.getByRole("option", { name: "Assistant" }).click();
  await expect(page).toHaveURL(`${base}/qa?assistant=new`);
  await panel.getByRole("button", { exact: true, name: "Close" }).click();
  await expect(page).toHaveURL(`${base}/qa`);

  await page.goto(`${base}/assistant`);
  await expect(page).toHaveURL(`${base}/desk?assistant=new`);
  await page.goto(`${base}/assistant?c=${ids[0]}`);
  await expect(page).toHaveURL(`${base}/desk?assistant=${ids[0]}`);
  await expect(
    panel.getByRole("heading", { exact: true, name: titles[0] })
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { exact: true, name: titles[2] })
  ).toBeVisible();
  await page.screenshot({ path: `${evidence}/assistant-desktop-1280x900.png` });

  await page.setViewportSize({ height: 844, width: 390 });
  await expect(
    panel.getByRole("navigation", { name: "Conversations" })
  ).toBeHidden();
  await expect(
    panel.getByRole("button", { exact: true, name: "History" })
  ).toBeVisible();
  await page.screenshot({ path: `${evidence}/assistant-phone-390x844.png` });
  await panel.getByRole("button", { exact: true, name: "History" }).click();
  await expect(
    panel.getByRole("navigation", { name: "Conversations" })
  ).toBeVisible();
  await expect(panel.getByLabel("Message", { exact: true })).toBeHidden();
  await page.screenshot({
    path: `${evidence}/assistant-phone-history-390x844.png`,
  });
  await panel.getByRole("button", { name: "Back to conversation" }).click();
  await expect(panel.getByLabel("Message", { exact: true })).toBeVisible();
  console.log(
    "PASS: lazy loading, toggle, URL preservation, conversation deep links/reload/switching, right column, dictation, Find, redirects, Esc/close, phone History/back, screenshots"
  );
} catch (caught) {
  console.log("Failure URL", page.url());
  await page.screenshot({ path: `${evidence}/debug-failure.png` });
  throw caught;
} finally {
  await browser.close();
}
