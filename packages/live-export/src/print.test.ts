import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { assets, deckFixture, docFixture } from "./fixtures/content";
import { deckPrintHTML, documentPrintHTML } from "./index";

test("Chrome prints representative document and exactly two slide pages without network", async () => {
  const browser = await chromium.launch({
    args: ["--no-sandbox"],
    executablePath: process.env.CHROME_BIN ?? "/usr/bin/google-chrome",
    headless: true,
  });
  try {
    const page = await browser.newPage();
    const requests: string[] = [];
    await page.route("**/*", (route) => {
      requests.push(route.request().url());
      return route.abort();
    });
    const document = await documentPrintHTML(docFixture(100), assets);
    await page.setContent(document.value);
    await page.emulateMedia({ media: "print" });
    expect(await page.locator("h1").textContent()).toContain("résumé");
    expect(await page.locator("table td").count()).toBe(2);
    expect(
      await page
        .locator("img")
        .evaluateAll((images) =>
          images.every(
            (image) =>
              image instanceof HTMLImageElement &&
              image.complete &&
              image.naturalWidth === 1
          )
        )
    ).toBe(true);
    const docPDF = await page.pdf({
      preferCSSPageSize: true,
      printBackground: true,
    });
    expect(docPDF.subarray(0, 5).toString()).toBe("%PDF-");
    expect(
      docPDF.toString("latin1").match(/\/Type \/Page\b/g)?.length
    ).toBeGreaterThan(1);
    const deck = await deckPrintHTML(deckFixture(), assets);
    await page.setContent(deck.value);
    expect(await page.locator("svg ellipse").count()).toBe(1);
    expect(await page.locator("svg ellipse").getAttribute("fill")).toBe(
      "#3b82f6"
    );
    const boxes = await page.locator(".slide").evaluateAll((elements) =>
      elements.map((e) => ({
        after: getComputedStyle(e).breakAfter,
        height: e.getBoundingClientRect().height,
        width: e.getBoundingClientRect().width,
      }))
    );
    expect(boxes).toEqual([
      { after: "page", height: 720, width: 1280 },
      { after: "auto", height: 720, width: 1280 },
    ]);
    const deckPDF = await page.pdf({
      preferCSSPageSize: true,
      printBackground: true,
    });
    const pdfText = deckPDF.toString("latin1");
    expect(pdfText.match(/\/Type \/Page\b/g)?.length).toBe(2);
    expect(requests).toEqual([]);
    await page.close();
  } finally {
    await browser.close();
  }
}, 30_000);
