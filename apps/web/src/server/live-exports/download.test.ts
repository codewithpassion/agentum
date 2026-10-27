/** biome-ignore-all lint/performance/noAwaitInLoops: Browser download cases exercise sequential UI transitions. */
/** biome-ignore-all lint/suspicious/useAwait: Injectable browser and route ports retain async signatures. */

import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { createLiveExportsService } from "@repo/services/live-exports";
import { file, serve, spawn } from "bun";
import { exportRouteHarness } from "./fixture";
import { printPDF } from "./pdf";

const pagePattern = /\/Type \/Page\b/g;
test("Chrome downloads all four formats through real export routes after warning review, retaining local edits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lx2-download-"));
  const build = spawn(
    [
      "bun",
      "build",
      new URL(
        "../../components/live-exports/fixtures/client.tsx",
        import.meta.url
      ).pathname,
      "--target",
      "browser",
      "--minify",
      "--outdir",
      directory,
    ],
    { stderr: "pipe", stdout: "pipe" }
  );
  if (await build.exited) {
    throw new Error(await new Response(build.stderr).text());
  }
  const js = await file(join(directory, "client.js")).text();
  const browser = await chromium.launch({
    args: ["--no-sandbox"],
    executablePath: "/usr/bin/google-chrome",
    headless: true,
  });
  const h = await exportRouteHarness();
  const deck = await exportRouteHarness("deck");
  const localPrint = printPDF(async () => {
    const context = await browser.newContext({
      javaScriptEnabled: false,
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    return { close: () => context.close(), page };
  });
  h.composed.services.liveExports = createLiveExportsService({
    ...h.deps,
    printPDF: localPrint,
  });
  deck.composed.services.liveExports = createLiveExportsService({
    ...deck.deps,
    printPDF: localPrint,
  });
  const server = serve({
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/client.js") {
        return new Response(js, {
          headers: { "Content-Type": "text/javascript" },
        });
      }
      if (url.pathname.startsWith("/api/")) {
        const target = url.pathname.includes(deck.artifactId) ? deck : h;
        return target.app.fetch(request, target.env);
      }
      const target = url.pathname === "/deck" ? deck : h;
      return new Response(
        `<!doctype html><div id="root" data-artifact="${target.artifactId}" data-kind="${url.pathname === "/deck" ? "deck" : "document"}"></div><script type="module" src="/client.js"></script>`,
        { headers: { "Content-Type": "text/html" } }
      );
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  try {
    const page = await browser.newPage({ acceptDownloads: true });
    const errors: string[] = [];
    let downloads = 0;
    page.on("download", () => {
      downloads += 1;
    });
    page.on("pageerror", (error) => {
      errors.push(error.message);
    });
    for (const kind of ["document", "deck"] as const) {
      await page.goto(`${server.url}${kind === "deck" ? "deck" : "document"}`);
      const sentinel = page.getByRole("textbox", {
        name: "Unsaved local edit",
      });
      await sentinel.fill("unsent edit must survive export");
      for (const format of [
        kind === "deck" ? "pptx" : "docx",
        "pdf",
      ] as const) {
        const beforeDownloads = downloads;
        const officeLabel =
          kind === "deck" ? "Export PowerPoint (.pptx)" : "Export Word (.docx)";
        await page
          .getByRole("button", {
            exact: true,
            name: format === "pdf" ? "Export PDF" : officeLabel,
          })
          .click();
        const review = page.getByRole("dialog", { name: "Review export" });
        await review.waitFor();
        expect(await review.locator("li").count()).toBeGreaterThan(0);
        expect(await review.textContent()).toContain("accepted revision 17");
        expect(downloads).toBe(beforeDownloads);
        const downloadReady = page.waitForEvent("download");
        await page
          .getByRole("button", { name: "Download reviewed export" })
          .click();
        const download = await downloadReady;
        expect(download.suggestedFilename()).toEndWith(`.${format}`);
        const path = await download.path();
        if (!path) {
          throw new Error("Browser did not save export");
        }
        const bytes = await file(path).bytes();
        if (format === "pdf") {
          const text = Buffer.from(bytes).toString("latin1");
          expect(text.startsWith("%PDF-")).toBe(true);
          if (kind === "deck") {
            expect(text.match(pagePattern)?.length).toBe(2);
          }
        } else {
          expect(bytes.subarray(0, 2)).toEqual(new Uint8Array([80, 75]));
          expect(bytes.length).toBeGreaterThan(100);
        }
        expect(await sentinel.inputValue()).toBe(
          "unsent edit must survive export"
        );
      }
      await page
        .getByRole("button", { exact: true, name: "Export PDF" })
        .click();
      await page.getByRole("button", { name: "Cancel export" }).click();
      expect(await page.getByRole("dialog").count()).toBe(0);
      const target = kind === "deck" ? deck : h;
      target.setPrincipal(null);
      await page
        .getByRole("button", { exact: true, name: "Export PDF" })
        .click();
      await page.getByRole("alert").waitFor();
      expect(await page.getByRole("alert").textContent()).toContain(
        "authentication"
      );
      expect(await sentinel.inputValue()).toBe(
        "unsent edit must survive export"
      );
    }
    expect(errors).toEqual([]);
  } finally {
    await server.stop(true);
    await browser.close();
    await rm(directory, { force: true, recursive: true });
  }
}, 30_000);
