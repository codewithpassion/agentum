// biome-ignore-all lint/performance/noAwaitInLoops: Ordered real network browser acceptance.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

const editorText = (page) =>
  page.evaluate(
    () => Reflect.get(window, "roomFixtureEditor")?.getText() ?? ""
  );
let input = "";
for await (const part of process.stdin) {
  input += part;
}
const { script, output } = JSON.parse(input);
const persistence = await mkdtemp(join(tmpdir(), "l8-room-network-"));
const runtime = new Miniflare(
  convertV4MiniflareOptions({
    compatibilityDate: "2026-08-19",
    durableObjects: {
      ROOM: { className: "TestArtifactRoom", useSQLite: true },
    },
    modules: true,
    resourcePersistencePath: persistence,
    script,
  })
);
const browser = await chromium.launch({ headless: true });
try {
  const base = new URL(await runtime.ready).origin;
  for (const viewport of [
    { height: 800, width: 1280 },
    { height: 844, width: 390 },
  ]) {
    const room = `browser-${viewport.width}`;
    await runtime.dispatchFetch(`${base}/control?room=${room}`, {
      body: JSON.stringify({ name: "urls", value: [] }),
      method: "POST",
    });
    const pair = await Promise.all([
      browser.newContext({
        hasTouch: viewport.width === 390,
        isMobile: viewport.width === 390,
        permissions: ["local-network-access"],
        viewport,
      }),
      browser.newContext({
        hasTouch: viewport.width === 390,
        isMobile: viewport.width === 390,
        permissions: ["local-network-access"],
        viewport,
      }),
    ]);
    const pages = await Promise.all(pair.map((context) => context.newPage()));
    const errors = [];
    for (const [index, page] of pages.entries()) {
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (event) => {
        if (event.type() === "error") {
          console.error(
            "Browser console",
            event.text().replace(/ticket=[^&\s\x27]+/g, "ticket=REDACTED")
          );
        }
      });
      page.on("response", (response) => {
        if (new URL(response.url()).pathname === "/ticket" && !response.ok()) {
          console.log("ticket request failed", response.status());
        }
      });
      await page.route("**/*", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path !== "/" && !path.startsWith("/assets/")) {
          await route.continue();
          return;
        }
        const filename = path === "/" ? "index.html" : path.slice(1);
        const mime =
          {
            ".css": "text/css",
            ".html": "text/html",
            ".js": "text/javascript",
          }[extname(filename)] ?? "application/octet-stream";
        await route.fulfill({
          body: await readFile(join(output, filename)),
          contentType: mime,
        });
      });
      await page.goto(
        `${base}/?room=${room}&participant=${index === 0 ? "alice" : "bob"}`
      );
      try {
        await expect(page.locator(".tiptap")).toContainText("Hello human.");
      } catch (error) {
        console.error(
          "Room browser diagnostics",
          await page.locator("body").innerText(),
          errors
        );
        throw error;
      }
    }
    const [alice, bob] = pages;
    await expect(
      alice.getByRole("button", {
        exact: true,
        name: "Follow Trusted bob (member)",
      })
    ).toBeVisible();
    await expect(
      bob.getByRole("button", {
        exact: true,
        name: "Follow Trusted alice (member)",
      })
    ).toBeVisible();
    await alice.bringToFront();
    await alice.locator(".tiptap p").click();
    await alice.keyboard.press("Home");
    await alice.keyboard.type("Alice ");
    await expect.poll(() => editorText(bob)).toContain("Alice Hello human.");
    await bob.bringToFront();
    await bob.locator(".tiptap p").click();
    await bob.keyboard.press("End");
    await bob.keyboard.type(" Bob");
    await expect.poll(() => editorText(alice)).toContain("Bob");
    await alice.bringToFront();
    await alice.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => editorText(bob)).toContain("Hello human. Bob");
    await expect.poll(() => editorText(bob)).toContain("AliceHello human.");
    await bob.bringToFront();
    await bob.locator(".tiptap p").click();
    await bob.keyboard.press("Home");
    await bob.keyboard.press("Shift+ArrowRight");

    await expect(
      alice
        .locator(".collaboration-carets__label")
        .filter({ hasText: /^Trusted bob$/ })
    ).toBeVisible();
    await expect(
      alice
        .locator(".collaboration-carets__label")
        .filter({ hasText: /^Trusted alice$/ })
    ).toHaveCount(0);
    await bob.locator(".tiptap").evaluate((node) => node.blur());
    await expect(
      alice
        .locator(".collaboration-carets__label")
        .filter({ hasText: /^Trusted bob$/ })
    ).toHaveCount(0);
    const ids = await alice.evaluate(() => {
      const provider = Reflect.get(window, "roomFixtureProvider");
      return {
        awareness: provider.awareness.clientID,
        document: provider.document.clientID,
      };
    });
    expect(ids.awareness).not.toBe(ids.document);
    await alice.reload();
    await expect.poll(() => editorText(alice)).toContain("Hello human. Bob");
    await expect(
      alice.getByRole("button", {
        exact: true,
        name: "Follow Trusted bob (member)",
      })
    ).toBeVisible();
    const reloadedIds = await alice.evaluate(() => {
      const provider = Reflect.get(window, "roomFixtureProvider");
      return {
        awareness: provider.awareness.clientID,
        document: provider.document.clientID,
      };
    });
    expect(reloadedIds.awareness).not.toBe(ids.awareness);
    expect(reloadedIds.awareness).not.toBe(reloadedIds.document);
    await alice.bringToFront();
    await alice.locator(".tiptap p").click();
    await alice.keyboard.press("End");
    await alice.keyboard.type("R");
    await expect.poll(() => editorText(bob)).toContain("BobR");
    await alice.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => editorText(bob)).toContain("Hello human. Bob");
    await expect.poll(() => editorText(bob)).not.toContain("BobR");
    await bob.bringToFront();
    await bob.locator(".tiptap p").click();
    await expect(
      alice
        .locator(".collaboration-carets__label")
        .filter({ hasText: /^Trusted bob$/ })
    ).toBeVisible();
    for (const role of ["commenter", "viewer"]) {
      await runtime.dispatchFetch(`${base}/control?room=${room}`, {
        body: JSON.stringify({ name: "role:bob", value: role }),
        method: "POST",
      });
      await runtime.dispatchFetch(`${base}/refresh?room=${room}`, {
        body: JSON.stringify({ id: "bob" }),
        method: "POST",
      });
      await expect(bob.getByRole("alert")).toContainText("permissions changed");
      await bob.reload();
      await expect(bob.locator(".tiptap")).toHaveAttribute(
        "contenteditable",
        "false"
      );
      await expect(
        bob.getByText(role === "commenter" ? "Comment only" : "Read only", {
          exact: true,
        })
      ).toBeVisible();
      await alice.bringToFront();
      await alice.locator(".tiptap p").click();
      await alice.keyboard.press("End");
      await alice.keyboard.type(role === "commenter" ? "C" : "V");
      await expect
        .poll(() => editorText(bob))
        .toContain(role === "commenter" ? "BobC" : "BobCV");
    }
    for (const page of pages) {
      await expect(page.getByRole("alert")).toHaveCount(0);
    }
    if (errors.length) {
      throw new Error(errors.join("\n"));
    }
    console.log(
      `PASS ${viewport.width}x${viewport.height}: actual workerd WebSockets, ticket/session controls, verified initial policy/content, server roster and named carets, two browser profiles, bidirectional edits, own undo before/after reconnect, fresh assigned IDs, self-filter, blur clearing, late peer roster/carets, commenter/viewer downgrade read sync`
    );
    for (const context of pair) {
      await context.close();
    }
  }
} finally {
  await browser.close();
  await runtime.dispose();
  await rm(persistence, { force: true, recursive: true });
}
