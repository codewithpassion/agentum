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
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const uploads = new Map<string, Buffer>();
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== "https://deck.fixture") {
        await route.abort();
        return;
      }
      if (url.pathname === "/fixture/upload") {
        const path = `/files/fixture_${uploads.size}`;
        uploads.set(path, route.request().postDataBuffer() ?? Buffer.alloc(0));
        await route.fulfill({ json: { path } });
        return;
      }
      if (uploads.has(url.pathname)) {
        await route.fulfill({
          body: uploads.get(url.pathname),
          contentType: "image/png",
        });
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
    await alice
      .getByRole("button", { exact: true, name: "Edit table cell 0:0" })
      .click();
    await expect(cell).toBeVisible();
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
    await alice.getByLabel("Upload image", { exact: true }).setInputFiles({
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=",
        "base64"
      ),
      mimeType: "image/png",
      name: "owned.png",
    });
    await expect(bob.locator(".ld-main img")).toHaveCount(1);
    await page.getByRole("button", { name: "Toggle Alice role" }).click();
    await expect(
      alice.getByRole("button", { exact: true, name: "Add slide" })
    ).toBeDisabled();
    await expect(alice.locator(".ld-main .tiptap")).toHaveCount(0);
    await page.getByRole("button", { name: "Toggle Alice role" }).click();
    await alice.locator(".ld-layers summary").click();
    await alice
      .getByRole("button", { exact: true, name: "shape: blue_box" })
      .click();
    await alice.getByLabel("x", { exact: true }).fill("520");
    await alice.getByLabel("x", { exact: true }).press("Tab");
    await expect(
      bob.locator('.ld-main div[data-element-id="blue_box"]')
    ).toHaveCSS("left", "520px");
    await alice.getByLabel("Positioning", { exact: true }).selectOption("flow");
    await expect(
      bob.locator('.ld-main div[data-element-id="blue_box"]')
    ).toHaveCSS("position", "relative");
    await alice
      .getByLabel("Positioning", { exact: true })
      .selectOption("pinned");
    await alice
      .getByRole("button", { exact: true, name: "text: headline" })
      .click();
    await alice
      .getByRole("button", { exact: true, name: "shape: blue_box" })
      .click({ modifiers: ["Shift"] });
    await alice.getByRole("button", { exact: true, name: "Group" }).click();
    await expect(
      bob.locator('.ld-main .ld-element[aria-label^="group "]')
    ).toHaveCount(1);
    await alice.getByRole("button", { exact: true, name: "Ungroup" }).click();
    await expect(
      bob.locator('.ld-main .ld-element[aria-label^="group "]')
    ).toHaveCount(0);
    await alice
      .getByRole("button", { exact: true, name: "Add connector" })
      .click();
    await expect(bob.locator(".ld-main svg[data-element-id]")).toHaveCount(1);
    await alice
      .getByRole("button", { exact: true, name: "Add colors token" })
      .click();
    await alice.getByLabel("colors token_1", { exact: true }).fill("#ef4444");
    await alice.getByLabel("colors token_1", { exact: true }).press("Tab");
    await expect(bob.getByLabel("colors token_1", { exact: true })).toHaveValue(
      "#ef4444"
    );
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
    await present
      .getByRole("button", { exact: true, name: "Fullscreen (F)" })
      .click();
    await expect
      .poll(() => page.evaluate(() => !!document.fullscreenElement))
      .toBe(true);
    await page.keyboard.press("f");
    await expect
      .poll(() => page.evaluate(() => !!document.fullscreenElement))
      .toBe(false);
    await expect(present.getByLabel("Presentation position")).toContainText(
      "build 0 / 3"
    );
    await expect(present.locator('[data-element-id="blue_box"]')).toHaveCount(
      0
    );
    await page.keyboard.press("ArrowRight");
    await expect(present.locator('[data-element-id="blue_box"]')).toBeVisible();
    await expect(present.getByLabel("Presentation position")).toContainText(
      "build 1 / 3"
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
      "build 3 / 3"
    );
    await expect(present.locator('[data-element-id="blue_box"]')).toHaveCount(
      0
    );
    await expect(
      present.locator('[data-element-id="timed_icon"]')
    ).toBeVisible();
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
    await bob.locator(".ld-thumbnail > button:first-child").nth(1).click();
    await alice
      .getByRole("button", { exact: true, name: "Bob · member" })
      .click();
    await expect(alice.locator(".ld-main .ld-scene")).toHaveAttribute(
      "data-slide-id",
      "closing"
    );
    await alice.locator(".ld-thumbnail > button:first-child").nth(0).click();
    await alice
      .getByRole("button", { exact: true, name: "Version history" })
      .click();
    await expect(page.getByTestId("events")).toContainText("history");
    await alice.getByRole("button", { exact: true, name: "Present" }).click();
    await alice
      .getByRole("button", { exact: true, name: "Present to everyone" })
      .click();
    const remotePresent = bob.locator(".ld-presentation");
    await expect(
      remotePresent.getByLabel("Presentation position")
    ).toContainText("Slide 1 / 2, build 0 / 3");
    await remotePresent
      .getByRole("button", { exact: true, name: "Leave presenter" })
      .click();
    await remotePresent
      .getByRole("button", { exact: true, name: "Exit presentation" })
      .click();
    await alice
      .getByRole("button", { exact: true, name: "Next build / slide" })
      .click();
    await expect(remotePresent).toHaveCount(0);
    await expect(page.getByTestId("events")).toContainText(
      '"build":1,"slideId":"opening"'
    );
    await alice
      .getByRole("button", { exact: true, name: "Stop presenting to everyone" })
      .click();
    await alice
      .getByRole("button", { exact: true, name: "Exit presentation" })
      .click();

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
