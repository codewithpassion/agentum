/** biome-ignore-all lint/performance/noAwaitInLoops: Real browser scenarios run sequentially in isolated desktop/mobile pages. */
/** Builds a fixture and serves it with request interception; no server or product-route edits. */
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { build } from "vite";

const directory = dirname(fileURLToPath(import.meta.url));
const output = await mkdtemp(join(tmpdir(), "ld3-browser-"));
const screenshots = resolve(directory, "../../../../../../../.artifacts/ld3");
await mkdir(screenshots, { recursive: true });
await build({
  base: "/",
  build: { emptyOutDir: true, outDir: output },
  configFile: false,
  logLevel: "warn",
  root: directory,
});
const browser = await chromium.launch({ headless: true });
try {
  for (const viewport of [
    { height: 800, width: 1280 },
    { height: 844, width: 390 },
  ]) {
    const page = await browser.newPage({
      hasTouch: viewport.width === 390,
      isMobile: viewport.width === 390,
      viewport,
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== "https://deck.fixture") {
        await route.abort();
        return;
      }
      const file = join(
        output,
        url.pathname === "/" ? "index.html" : url.pathname
      );
      try {
        await route.fulfill({
          body: await readFile(file),
          contentType:
            (
              {
                ".css": "text/css",
                ".html": "text/html",
                ".js": "text/javascript",
              } as Record<string, string>
            )[extname(file)] ?? "application/octet-stream",
        });
      } catch {
        await route.fulfill({ body: "Not found", status: 404 });
      }
    });
    await page.goto("https://deck.fixture");
    const alice = page.locator('[data-replica="alice"]');
    const bob = page.locator('[data-replica="bob"]');
    const text = alice.locator('.ld-main [data-element-id="headline"] .tiptap');
    await expect(text).toHaveText("Edit text");
    await text.click();
    await page.keyboard.press("Home");
    await page.keyboard.type("Alice ");
    await expect(
      bob.locator('.ld-main [data-element-id="headline"]')
    ).toContainText("Alice");
    const cell = alice
      .locator('.ld-main [data-element-id="data_table"] td .tiptap')
      .first();
    await cell.click();
    await page.keyboard.type("Shared cell");
    await expect(
      bob.locator('.ld-main [data-element-id="data_table"] td').first()
    ).toContainText("Shared cell");
    await alice.locator('.ld-main [data-element-id="headline"]').click();
    await alice
      .getByRole("button", { exact: true, name: "Comment on selection" })
      .click();
    await expect(page.getByTestId("events")).toContainText(
      '"elementIds":["headline"],"slideId":"opening","slideNumber":1'
    );
    await alice
      .getByLabel("Speaker notes", { exact: true })
      .fill("Updated speaker notes");
    await expect(bob.getByLabel("Speaker notes", { exact: true })).toHaveValue(
      "Updated speaker notes"
    );
    await page.getByRole("button", { name: "Toggle Alice role" }).click();
    await expect(
      alice.getByRole("button", { exact: true, name: "Add slide" })
    ).toBeDisabled();
    await expect(alice.locator(".ld-main .tiptap")).toHaveCount(0);
    await page.getByRole("button", { name: "Toggle Alice role" }).click();
    await alice
      .getByRole("button", { exact: true, name: "All slides" })
      .click();
    await expect(alice.locator(".ld-workspace")).toHaveClass(/ld-grid-mode/);
    await alice
      .getByRole("button", { exact: true, name: "Slide strip" })
      .click();
    await alice
      .getByRole("button", { exact: true, name: "Hide pointers" })
      .click();
    await alice.getByRole("button", { exact: true, name: "Present" }).click();
    const present = alice.locator(".ld-presentation");
    await expect(present.getByLabel("Presentation position")).toContainText(
      "build 0 / 1"
    );
    await expect(present.locator('[data-element-id="blue_box"]')).toHaveCount(
      0
    );
    await page.keyboard.press("ArrowRight");
    await expect(present.locator('[data-element-id="blue_box"]')).toBeVisible();
    await expect(present.getByLabel("Presentation position")).toContainText(
      "build 1 / 1"
    );
    await present
      .getByRole("button", { exact: true, name: "Presenter notes" })
      .click();
    await expect(
      present.getByText("Updated speaker notes", { exact: true })
    ).toBeVisible();
    await page.screenshot({
      fullPage: true,
      path: join(screenshots, `present-${viewport.width}.png`),
    });
    await page.keyboard.press("ArrowRight");
    await expect(present.getByLabel("Presentation position")).toContainText(
      "Slide 2 / 2"
    );
    await page.keyboard.press("Home");
    await expect(present.getByLabel("Presentation position")).toContainText(
      "Slide 1 / 2"
    );
    await page.keyboard.press("End");
    await expect(present.getByLabel("Presentation position")).toContainText(
      "Slide 2 / 2"
    );
    await page.keyboard.press("Escape");
    await expect(present).toHaveCount(0);
    await alice.getByRole("button", { exact: true, name: "Add slide" }).click();
    await expect(bob.locator(".ld-thumbnail")).toHaveCount(3);
    await alice
      .getByRole("button", { exact: true, name: "Duplicate slide" })
      .click();
    await expect(bob.locator(".ld-thumbnail")).toHaveCount(4);
    await alice
      .getByRole("button", { exact: true, name: "Delete slide" })
      .click();
    await expect(bob.locator(".ld-thumbnail")).toHaveCount(3);
    await page.screenshot({
      fullPage: true,
      path: join(screenshots, `editor-${viewport.width}.png`),
    });
    expect(errors).toEqual([]);
    await page.close();
    console.log(
      `PASS ${viewport.width}x${viewport.height}: two admitted replicas, text/cells/notes, role downgrade, selection callbacks, builds, keyboard, grid and slides`
    );
  }
} finally {
  await browser.close();
}
console.log(`Screenshots: ${screenshots}`);
