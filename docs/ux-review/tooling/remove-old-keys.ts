#!/usr/bin/env bun
// Removes the model keys from the abandoned review workspaces. Their agents are already archived.
import { $ } from "bun";
import { chromium } from "playwright";

const WEB = `${import.meta.dir}/../../../apps/web`;
const browser = await chromium.launch();
for (const email of [
  "ux-review@rockyshoreslabs.io",
  "priya@northbank.rockyshoreslabs.io",
  "priya.nair@northbank.rockyshoreslabs.io",
]) {
  const out =
    await $`bun run agent-login --env staging --email ${email} --redirect /settings/model-providers`
      .cwd(WEB)
      .quiet()
      .text();
  const ctx = await browser.newContext({
    viewport: { height: 900, width: 1440 },
  });
  const page = await ctx.newPage();
  await page.goto(out.trim().split("\n").at(-1) ?? "", {
    timeout: 90_000,
    waitUntil: "networkidle",
  });
  await page.waitForTimeout(3000);
  for (let i = 0; i < 2; i += 1) {
    const remove = page.getByRole("button", { name: "Remove key" });
    if (!(await remove.count())) {
      break;
    }
    await remove.first().click();
    await page.waitForTimeout(600);
    const confirm = page
      .locator("[role=alertdialog],[role=dialog]")
      .getByRole("button", { name: /Remove/ });
    if (await confirm.count()) {
      await confirm.last().click();
    }
    await page.waitForTimeout(2000);
  }
  console.log(
    email,
    "keys left:",
    await page.getByRole("button", { name: "Remove key" }).count()
  );
  await ctx.close();
}
await browser.close();
