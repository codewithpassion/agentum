#!/usr/bin/env bun
// Screenshots each direction in each state, and exercises the rail's pop-up motion.
import { chromium } from "playwright";

const FILE = `file://${import.meta.dir}/../mockups/index.html`;
const OUT = `${import.meta.dir}/../media/mockups`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { height: 900, width: 1440 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(String(e)));
for (const dir of ["a", "b", "c"]) {
  for (const day of ["30", "1"]) {
    await page.goto(`${FILE}?dir=${dir}&day=${day}`);
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${OUT}/${dir}-day${day}.png` });
  }
}
await page.goto(`${FILE}?dir=a&day=30`);
await page.getByRole("button", { name: "Send reply" }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/a-after-send.png` });
await page.waitForTimeout(1800);
await page.getByRole("button", { name: /Pretend a new email/ }).click();
await page.waitForTimeout(2600);
await page.screenshot({ path: `${OUT}/a-new-mail.png` });
await page.getByRole("button", { exact: true, name: "Find" }).click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/a-palette.png` });
await page.keyboard.press("Escape");
await page.getByRole("button", { name: "Where did everything go?" }).click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/map.png` });
await page.goto(`${FILE}?dir=c&day=1`);
await page.getByRole("button", { name: "something happens" }).click();
await page.getByRole("button", { name: "an email arrives" }).click();
await page.getByRole("button", { name: "Continue with Google" }).click();
await page.getByRole("button", { name: "decide who approves" }).click();
await page.getByRole("button", { name: "ask me first" }).click();
await page.getByRole("button", { name: "Try it on this email" }).click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/c-builder-filled.png` });
await page.goto(`${FILE}?dir=c&day=30`);
await page.getByRole("button", { name: "Today" }).click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/c-today.png` });
await browser.close();
console.log(errors.length ? errors.join("\n") : "no page errors");
