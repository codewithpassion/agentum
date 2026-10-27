// biome-ignore-all lint/performance/noAwaitInLoops: ordered browser and durable room decisions.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

let raw = "";
for await (const part of process.stdin) {
  raw += part;
}
const { script, output } = JSON.parse(raw);
const persistence = await mkdtemp(join(tmpdir(), "suggestion-browser-"));
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
let assertions = 0;
try {
  const base = new URL(await runtime.ready).origin;
  for (const width of [1280, 390]) {
    for (const kind of ["document", "deck"]) {
      const room = `review-${kind}-${width}`;
      const call = async (path, input = {}) => {
        const response = await runtime.dispatchFetch(
          `${base}${path}?room=${room}`,
          { body: JSON.stringify(input), method: "POST" }
        );
        if (!response.ok) {
          throw new Error(await response.text());
        }
        return response.json();
      };
      if (kind === "deck") {
        await call("/control", { name: "deck", value: true });
      }
      const page = await browser.newPage({ viewport: { height: 844, width } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.startsWith("/api/trpc/")) {
          const paths = url.pathname.slice("/api/trpc/".length).split(",");
          const inputs = JSON.parse(
            route.request().method() === "GET"
              ? url.searchParams.get("input")
              : route.request().postData()
          );
          const results = [];
          for (const [i, path] of paths.entries()) {
            const input = inputs[i];
            let data;
            if (path === "liveArtifacts.suggestions") {
              data = await call("/suggestions");
            } else if (path === "liveArtifacts.setSuggestionMode") {
              data = await call("/suggestion-mode", input);
            } else if (path === "liveArtifacts.decideSuggestion") {
              data = await call("/suggestion-decision", input);
            } else {
              throw new Error(`Unexpected fixture RPC ${path}`);
            }
            results.push({ result: { data } });
          }
          await route.fulfill({
            body: JSON.stringify(results),
            contentType: "application/json",
          });
          return;
        }
        const path =
          url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        const bytes = await readFile(join(output, path));
        const types = {
          ".css": "text/css",
          ".html": "text/html",
          ".js": "application/javascript",
        };
        await route.fulfill({
          body: bytes,
          contentType: types[extname(path)] ?? "application/octet-stream",
        });
      });
      await page.goto(`${base}/`);
      await expect(page.getByText("No suggestions yet.")).toBeVisible();
      await page.getByRole("checkbox").click();
      await expect(page.getByRole("checkbox")).toBeChecked();
      const propose = async (id) => {
        if (kind === "document") {
          await call("/ops", {
            ops: [{ content: { text: id }, op: "insert" }],
            origin: {
              changeId: id,
              mode: "direct",
              participantId: "agent",
              runId: "run",
              toolCallId: id,
            },
          });
        } else {
          await call("/deck-write", {
            changeId: id,
            ops: [
              {
                html: `<slide id="${id}" order="a0" background="#fff" transition="none" duration="0"></slide>`,
                op: "add",
              },
            ],
          });
        }
      };
      const accepted = async () =>
        kind === "document"
          ? (await call("/read")).content
          : JSON.stringify((await call("/deck-read")).slides);
      await propose("accept-browser");
      expect(await accepted()).not.toContain("accept-browser");
      await expect(
        page.getByRole("button", { exact: true, name: "Accept suggestion" })
      ).toBeVisible({ timeout: 12_000 });
      await page.getByText(`Preview ${kind} suggestion`).click();
      await expect(page.locator("pre")).toContainText("accept-browser");
      await page
        .getByRole("button", { exact: true, name: "Accept suggestion" })
        .click();
      await expect(page.getByText(/Trusted agent · accepted/)).toBeVisible();
      expect(await accepted()).toContain("accept-browser");
      await propose("reject-browser");
      await expect(
        page.getByRole("button", { exact: true, name: "Reject suggestion" })
      ).toBeVisible({ timeout: 12_000 });
      await page
        .getByRole("button", { exact: true, name: "Reject suggestion" })
        .click();
      await expect(page.getByText(/Trusted agent · rejected/)).toBeVisible();
      expect(await accepted()).not.toContain("reject-browser");
      await page.reload();
      await expect(page.getByText(/Trusted agent · accepted/)).toBeVisible();
      await expect(page.getByText(/Trusted agent · rejected/)).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth
        )
      ).toBe(true);
      expect(errors).toEqual([]);
      assertions += 11;
      await page.close();
    }
  }
  console.log(
    JSON.stringify({
      kinds: ["document", "deck"],
      passed: assertions,
      viewports: [1280, 390],
    })
  );
} finally {
  await browser.close();
  await runtime.dispose();
  await rm(persistence, { force: true, recursive: true });
}
