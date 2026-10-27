/** biome-ignore-all lint/performance/noAwaitInLoops: Desktop and mobile browser assertions run sequentially with isolated pages. */
/** Run with bun from repository root. Builds a local fixture, serves it through
 * Playwright request interception, and opens no server or shared preview tab. */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import tailwindcss from "@tailwindcss/vite";
import { build } from "vite";

const directory = dirname(fileURLToPath(import.meta.url));
const output = await mkdtemp(join(tmpdir(), "l8a-browser-"));
const browser = await chromium.launch({ headless: true });
try {
  await build({
    base: "/",
    build: { emptyOutDir: true, outDir: output },
    configFile: false,
    logLevel: "warn",
    plugins: [tailwindcss()],
    resolve: { alias: { "#": resolve(directory, "../../..") } },
    root: directory,
  });
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
    page.on("pageerror", (error) => {
      errors.push(error.message);
      console.error("FIXTURE ERROR", error.stack);
    });
    const uploads = new Map<string, Buffer>();
    const externalRequests: string[] = [];
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/fixture/import") {
        expect(route.request().postDataJSON()).toEqual({
          url: "https://images.unsplash.com/photo",
        });
        const path = "/files/imported.png";
        uploads.set(
          path,
          Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6XQAAAAASUVORK5CYII=",
            "base64"
          )
        );
        await route.fulfill({ json: { alt: "Imported image", url: path } });
        return;
      }
      if (url.pathname === "/fixture/upload") {
        const path = `/files/fixture-${uploads.size}.png`;
        uploads.set(path, route.request().postDataBuffer() ?? Buffer.alloc(0));
        await route.fulfill({
          json: { alt: "Fixture uploaded image", url: path },
        });
        return;
      }
      if (uploads.has(url.pathname)) {
        await route.fulfill({
          body: uploads.get(url.pathname),
          contentType: "image/png",
        });
        return;
      }
      if (url.origin !== "https://editor.fixture") {
        externalRequests.push(url.href);
        await route.abort();
        return;
      }
      try {
        const file = join(
          output,
          url.pathname === "/" ? "index.html" : url.pathname
        );
        await route.fulfill({
          body: await readFile(file),
          contentType:
            {
              ".css": "text/css",
              ".html": "text/html",
              ".js": "text/javascript",
            }[extname(file)] ?? "application/octet-stream",
        });
      } catch {
        await route.fulfill({ body: "Not found", status: 404 });
      }
    });
    await page.goto("https://editor.fixture");
    const alice = page.locator('[data-replica="alice"]');
    const bob = page.locator('[data-replica="bob"]');
    // ProseMirror contenteditable uses role=textbox through this fixture assertion.
    await expect(alice.locator(".tiptap")).toBeVisible();
    const editor = alice.locator(".tiptap");
    await expect(
      alice.getByText("Research agent: Rewriting the introduction", {
        exact: true,
      })
    ).toBeVisible();
    await editor.locator("p").first().click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    await alice
      .locator("summary")
      .filter({ hasText: /^Text$/ })
      .click();
    await alice.getByRole("button", { exact: true, name: "Bold" }).click();
    await expect(bob.locator(".tiptap strong")).toHaveText(
      "Collaborative document"
    );
    await alice
      .locator("summary")
      .filter({ hasText: /^Case$/ })
      .click();
    await alice
      .getByRole("button", { exact: true, name: "UPPER CASE" })
      .click();
    await expect(bob.locator(".tiptap strong")).toHaveText(
      "COLLABORATIVE DOCUMENT"
    );
    await alice.getByRole("button", { exact: true, name: "Ask agent" }).click();
    await alice
      .getByRole("button", { exact: true, name: "Comment on selection" })
      .click();
    expect(
      await page.evaluate(
        () => Reflect.get(window, "editorFixture").events.ask.text
      )
    ).toBe("COLLABORATIVE DOCUMENT");
    expect(
      await page.evaluate(
        () => Reflect.get(window, "editorFixture").events.comment.start
      )
    ).toBeTruthy();
    await bob.locator(".tiptap p").first().click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    await expect(
      alice.locator(".collaboration-carets__label").filter({ hasText: /^Bob$/ })
    ).toHaveText("Bob", { timeout: 500 });
    await expect(alice.locator(".ProseMirror-yjs-selection")).not.toHaveCount(
      0
    );
    await alice
      .getByRole("button", { exact: true, name: "Follow Bob (guest)" })
      .click();
    await expect(
      alice.getByText("Following Bob. Scroll or click to stop.")
    ).toBeVisible();
    await page.mouse.wheel(0, 50);
    await expect(
      alice.getByText("Following Bob. Scroll or click to stop.")
    ).toHaveCount(0);
    await alice
      .getByRole("button", { exact: true, name: "Version history" })
      .click();
    await page
      .getByRole("button", { exact: true, name: "Restore Original" })
      .click();
    await page.evaluate(() =>
      Reflect.get(window, "editorFixture").setRole("viewer")
    );
    await expect(
      page.getByRole("button", { exact: true, name: "Confirm restore" })
    ).toHaveCount(0);
    await page.evaluate(() =>
      Reflect.get(window, "editorFixture").setRole("owner")
    );
    await expect(
      page.getByRole("button", { exact: true, name: "Confirm restore" })
    ).toHaveCount(0);
    await page
      .getByRole("button", { exact: true, name: "Restore Original" })
      .click();
    await page
      .getByRole("button", { exact: true, name: "Confirm restore" })
      .click();
    await expect(bob.locator(".tiptap p").first()).toHaveText(
      "Collaborative document"
    );
    await alice
      .locator("summary")
      .filter({ hasText: /^Insert$/ })
      .click();
    await alice.getByLabel("Upload image", { exact: true }).setInputFiles({
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6XQAAAAASUVORK5CYII=",
        "base64"
      ),
      mimeType: "image/png",
      name: "fixture.png",
    });
    await expect(bob.locator(".tiptap img[src]")).toHaveCount(1);
    expect(uploads.size).toBe(1);
    await alice
      .getByLabel("Mention a person", { exact: true })
      .selectOption("bob");
    await expect(bob.locator("[data-mention=bob]")).toHaveText("@Bob");
    await alice.getByLabel("Date chip", { exact: true }).fill("2026-10-27");
    await alice
      .getByRole("button", { exact: true, name: "Insert date" })
      .click();
    await expect(bob.locator("[data-date='2026-10-27']")).toHaveText(
      "2026-10-27"
    );
    await page.evaluate(() => {
      const target = document.querySelector('[data-replica="alice"] .tiptap');
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([new Uint8Array([137, 80, 78, 71])], "pasted.png", {
          type: "image/png",
        })
      );
      target?.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: transfer,
        })
      );
    });
    await expect.poll(() => uploads.size).toBe(2);
    await expect(bob.locator(".tiptap img[src]")).toHaveCount(1);
    expect(uploads.size).toBe(2);
    await alice
      .getByLabel("Image URL", { exact: true })
      .fill("https://images.unsplash.com/photo");
    await alice
      .getByRole("button", { exact: true, name: "Insert image URL" })
      .click();
    await expect(bob.locator('img[src="/files/imported.png"]')).toHaveCount(1);
    await expect
      .poll(() =>
        bob
          .locator('img[src="/files/imported.png"]')
          .evaluate((image) => (image as HTMLImageElement).naturalWidth)
      )
      .toBe(1);
    expect(
      externalRequests.filter(
        (url) => new URL(url).hostname === "images.unsplash.com"
      )
    ).toEqual([]);

    const downloading = page.waitForEvent("download");
    await alice
      .getByRole("button", { exact: true, name: "Download markdown" })
      .click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe("document.md");
    const file = await download.path();
    expect(file && (await readFile(file, "utf8"))).toContain(
      "Collaborative document"
    );
    await page.evaluate(() => Reflect.get(window, "editorFixture").reset());
    await alice.locator(".tiptap p").first().click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    await page.keyboard.type("/heading 2");
    if (viewport.width === 390) {
      await page.keyboard.press("Enter");
    } else {
      await alice
        .getByRole("group", { exact: true, name: "Insert block" })
        .getByRole("button", { exact: true, name: "Heading 2" })
        .click();
    }
    await page.keyboard.type("New heading");
    await expect(bob.locator(".tiptap h2")).toContainText("New heading");
    expect(
      await page.evaluate(
        () =>
          Reflect.get(window, "editorFixture")
            .json(1)
            .content.find((node: { type: string }) => node.type === "heading")
            .content
      )
    ).toEqual([{ text: "New heading", type: "text" }]);
    const handle = alice.getByRole("button", {
      exact: true,
      name: "Drag heading block",
    });
    if (viewport.width === 1280) {
      const pending = alice.locator(".tiptap [data-pending]");
      const bounds = await pending.boundingBox();
      if (!bounds) {
        throw new Error("Missing pending block target");
      }
      await handle.dragTo(pending, {
        targetPosition: { x: 20, y: bounds.height - 2 },
      });
      await expect
        .poll(() =>
          page.evaluate(
            () => Reflect.get(window, "editorFixture").json(1).content[0].type
          )
        )
        .toBe("pending");
      await handle.focus();
      await page.keyboard.press("ArrowUp");
      await expect
        .poll(() =>
          page.evaluate(
            () => Reflect.get(window, "editorFixture").json(1).content[0].type
          )
        )
        .toBe("heading");
    }
    await handle.focus();
    await page.keyboard.press("ArrowDown");
    await expect
      .poll(() =>
        page.evaluate(() =>
          Reflect.get(window, "editorFixture")
            .json(1)
            .content.slice(0, 2)
            .map((node: { type: string }) => node.type)
        )
      )
      .toEqual(["pending", "heading"]);
    await page.evaluate(() =>
      Reflect.get(window, "editorFixture").setRole("commenter")
    );
    await expect(editor).toHaveAttribute("contenteditable", "false");
    await expect(
      alice.getByRole("button", { exact: true, name: "Undo" })
    ).toBeDisabled();
    await expect(alice.locator("summary")).toHaveCount(0);
    await page.evaluate(() =>
      Reflect.get(window, "editorFixture").setRole("viewer")
    );
    await alice
      .getByRole("button", { exact: true, name: "Version history" })
      .click();
    await expect(
      page.getByRole("button", { exact: true, name: "Restore Original" })
    ).toHaveCount(0);
    await page
      .getByRole("button", { exact: true, name: "Close history" })
      .click();
    await page.evaluate(() =>
      Reflect.get(window, "editorFixture").setRole("owner")
    );
    await expect(editor).toHaveAttribute("contenteditable", "true");
    await expect(alice.locator("summary")).toHaveCount(5);
    await page.evaluate(() => {
      for (const details of document.querySelectorAll("details")) {
        details.open = true;
      }
    });
    const metrics = await page.evaluate(() => ({
      controls: [
        ...document.querySelectorAll(
          ".live-editor button,.live-editor input,.live-editor select,.live-editor summary"
        ),
      ]
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            height: rect.height,
            label: element.getAttribute("aria-label") ?? element.textContent,
            width: rect.width,
          };
        }),
      width: document.documentElement.scrollWidth,
    }));
    expect(metrics.width).toBeLessThanOrEqual(viewport.width);
    expect(
      metrics.controls.filter(
        (control) => control.height < 40 || control.width < 40
      )
    ).toEqual([]);
    await expect(
      alice.getByText("Research agent: Rewriting the introduction", {
        exact: true,
      })
    ).toHaveCount(0, { timeout: 5000 });
    await expect(
      alice
        .locator(".collaboration-carets__label")
        .filter({ hasText: /^Research agent$/ })
    ).toHaveCount(0);
    expect(errors).toEqual([]);
    console.log(
      `PASS ${viewport.width}x${viewport.height}: collaboration/carets/selections, toolbar/case/slash/chips, selection callbacks, follow, restore/export, upload/paste; ${metrics.controls.length} visible controls >=40px; no horizontal overflow`
    );
    await page.close();
  }
} finally {
  await browser.close();
  await rm(output, { force: true, recursive: true });
}
