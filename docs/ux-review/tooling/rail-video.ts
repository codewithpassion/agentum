#!/usr/bin/env bun
// Tests the rail on staging as real people and records it: Nina on her first day,
// Priya and Dan on a normal one. Mail comes from the simulator workspace, so it takes
// the real inbound path. Writes media/rail/acceptance.json and the video.
// Run from this folder: bun rail-video.ts
import { mkdir, rm } from "node:fs/promises";
import { parseEnv } from "node:util";
import { $ } from "bun";
import {
  type Browser,
  chromium,
  type Locator,
  type Page,
} from "playwright";

const BASE = "https://harbourmaster-staging.rockyshoreslabs.io";
const WEB = `${import.meta.dir}/../../../apps/web`;
const MEDIA = `${import.meta.dir}/../media/rail`;
const VIEWPORT = { height: 900, width: 1440 };
const PRIYA = "priya@office.northbank.rockyshoreslabs.io";
const DAN = "dan@office.northbank.rockyshoreslabs.io";
const NINA = "nina@firstday.rockyshoreslabs.io";
const SIM = "ux-sim@rockyshoreslabs.io";
const SIM_AGENT = "01M65WDB47F5MJYWYQ8JGQ38QZ";
const COS = "01M65XPZE6Q9MV2PW811VTMJQ7";
const CHASER = "01M65XS89M9MYBGWXTMXJH0PPA";
const OFFICE = "northbank-office@rockyshoreslabs.io";
const SLOW = 240_000;
const env = parseEnv(await Bun.file(`${WEB}/.env.local`).text());

const BATCH_A = `Send these four test emails to ${OFFICE}, one email each, with the subject and body exactly as written. Start each body with the "Originally from" line. Do not send anything else.

1. Subject: Fwd: Board pack needs the new forecast by tomorrow 9am
Originally from: Tom Reid <tom.reid@kestrel-energy.example>
Our board meets tomorrow. We need the updated forecast and the risk slide by 9am tomorrow. Who is on this? Tom

2. Subject: Fwd: Revised fee note for the board
Originally from: Tom Reid <tom.reid@kestrel-energy.example>
Can you also send the revised fee note for the board? Tom

3. Subject: Fwd: Moving Thursday's review
Originally from: Jane Doe <jane.doe@harcourt-logistics.example>
Hi all, could we move Thursday's strategy review to Friday, and add a section on pricing options? Thanks, Jane

4. Subject: Fwd: Invoice INV-2041 is 31 days overdue
Originally from: Accounts <accounts@brightwell-foods.example>
Our system shows INV-2041 ($18,400) unpaid. Please resend it with the correct PO number and we will pay this cycle.`;

const BATCH_B = `Send this one test email to ${OFFICE}, with the subject and body exactly as written. Start the body with the "Originally from" line. Do not send anything else.

Subject: Fwd: Lease renewal, please confirm today
Originally from: Lena at Fairway Property <lena@fairway-property.example>
Your lease on Level 4 ends on 31 January. Please confirm renewal today.`;

const CHASER_RULE =
  "\n\nYou have no invoice records, so never look for them and never stop to verify anything. When you get an overdue invoice, always write a short reminder at once to the sender on the Originally from line with the mail tool, which holds it for a person to approve. Do this every time.";

const results: { name: string; pass: boolean; detail?: string }[] = [];
const check = (name: string, pass: boolean, detail?: string) => {
  results.push({ name, pass, ...(detail ? { detail } : {}) });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail.slice(0, 120)})` : ""}`);
};

const loginUrl = async (email: string, redirect: string) =>
  (
    await $`bun run agent-login --env staging --email ${email} --redirect ${redirect}`
      .cwd(WEB)
      .quiet()
      .text()
  )
    .trim()
    .split("\n")
    .at(-1) ?? "";

const INIT = `
window.addEventListener("DOMContentLoaded", () => {
  const dot = document.createElement("div");
  Object.assign(dot.style, { position: "fixed", left: "-40px", top: "-40px", width: "22px", height: "22px",
    marginLeft: "-11px", marginTop: "-11px", borderRadius: "50%", background: "rgba(255,196,0,.45)",
    border: "2px solid rgba(40,40,40,.8)", zIndex: 2147483647, pointerEvents: "none", transition: "transform 120ms" });
  document.body.appendChild(dot);
  addEventListener("mousemove", (e) => { dot.style.left = e.clientX + "px"; dot.style.top = e.clientY + "px"; }, true);
  addEventListener("mousedown", () => { dot.style.transform = "scale(.7)"; }, true);
  addEventListener("mouseup", () => { dot.style.transform = "scale(1)"; }, true);
  const cap = document.createElement("div");
  Object.assign(cap.style, { position: "fixed", left: "50%", bottom: "24px", transform: "translateX(-50%)", maxWidth: "980px",
    padding: "10px 18px", borderRadius: "10px", background: "rgba(20,20,19,.9)", color: "#fff", font: "500 19px/1.35 system-ui,sans-serif",
    textAlign: "center", zIndex: 2147483646, pointerEvents: "none" });
  document.body.appendChild(cap);
  window.__setCap = (t) => { cap.textContent = t; cap.style.display = t ? "block" : "none"; };
  window.__setCap(sessionStorage.getItem("__cap") || "");
});`;

interface Range {
  endMs: number;
  startMs: number;
}

/** One person's browser and video, with slow server waits cut. */
class Seg {
  readonly cuts: Range[] = [];
  readonly page: Page;
  private readonly start: number;
  private pointer = { x: 720, y: 450 };

  constructor(page: Page) {
    this.page = page;
    this.start = Date.now();
  }

  private now = () => Date.now() - this.start;

  async cap(text: string, holdMs = 3400) {
    await this.page
      .evaluate((t) => {
        sessionStorage.setItem("__cap", t);
        (window as unknown as { __setCap?: (s: string) => void }).__setCap?.(t);
      }, text)
      .catch(() => undefined);
    await this.page.waitForTimeout(holdMs);
  }

  async wait<T>(work: () => Promise<T>, keepMs = 500): Promise<T> {
    const startMs = this.now();
    const out = await work();
    const endMs = this.now() - keepMs;
    if (endMs > startMs) {
      this.cuts.push({ endMs, startMs });
    }
    return out;
  }

  off<T>(work: () => Promise<T>) {
    return this.wait(work, 0);
  }

  async goto(path: string) {
    await this.wait(() =>
      this.page.goto(BASE + path, { timeout: 90_000, waitUntil: "networkidle" })
    );
    await this.page.waitForTimeout(500);
  }

  private async glide(target: Locator) {
    await this.wait(() =>
      target.first().waitFor({ state: "visible", timeout: SLOW })
    );
    await target.first().scrollIntoViewIfNeeded();
    const box = await target.first().boundingBox();
    if (!box) {
      throw new Error(`No box for ${target}`);
    }
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const steps = Math.max(8, Math.round(Math.hypot(x - this.pointer.x, y - this.pointer.y) / 30));
    await this.page.mouse.move(x, y, { steps });
    this.pointer = { x, y };
  }

  async click(target: Locator) {
    await this.glide(target);
    await this.page.waitForTimeout(220);
    await target.first().click();
    await this.page.waitForTimeout(350);
  }

  async hover(target: Locator, holdMs = 800) {
    await this.glide(target);
    await this.page.waitForTimeout(holdMs);
  }

  async fill(target: Locator, text: string) {
    await this.click(target);
    await target.first().fill(text);
    await this.page.waitForTimeout(250);
  }

  async shot(name: string) {
    await this.off(async () => {
      await this.page.evaluate(() => (window as unknown as { __setCap?: (s: string) => void }).__setCap?.(""));
      await this.page.screenshot({ path: `${MEDIA}/screens/${name}.png` });
      await this.page.evaluate(() =>
        (window as unknown as { __setCap?: (s: string) => void }).__setCap?.(sessionStorage.getItem("__cap") || "")
      );
    });
  }

  markEnd() {
    return this.now();
  }
}

const rows = (page: Page) => page.locator('a[href*="item="]');
const bodyText = (page: Page) => page.locator("body").innerText();
const pollUntil = async (test: () => Promise<boolean>, timeoutMs: number, everyMs = 4000) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    // biome-ignore lint/performance/noAwaitInLoops: polling
    if (await test()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return false;
};

/** Runs one scene, and records a failure without stopping the rest. */
const scene = async (name: string, work: () => Promise<void>) => {
  console.log(`scene ${name}`);
  try {
    await work();
  } catch (error) {
    check(`scene ${name} finished`, false, String(error));
  }
};

const sendMail = async (browser: Browser, emails: string, expect: number) => {
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  const page = await ctx.newPage();
  await page.goto(await loginUrl(SIM, `/agents/${SIM_AGENT}`), { timeout: 90_000, waitUntil: "networkidle" });
  await page.waitForTimeout(3000);
  await page.getByRole("button", { name: "Run now" }).click();
  const dialog = page.locator("[role=dialog]");
  await dialog.locator("textarea").fill(emails);
  await dialog.getByRole("button", { name: "Start task" }).click();
  await page.waitForURL(/tasks\//, { timeout: 30_000 });
  let approved = 0;
  for (let i = 0; i < 60 && approved < expect; i += 1) {
    const allow = page.getByRole("button", { name: "Allow once" });
    // biome-ignore lint/performance/noAwaitInLoops: one approval at a time
    if (await allow.count()) {
      await allow.first().click();
      approved += 1;
      await page.waitForTimeout(2000);
    } else {
      await page.waitForTimeout(3000);
    }
  }
  console.log(`simulated mail approved: ${approved}`);
  await ctx.close();
};

const remote = async (sql: string) =>
  $`bunx wrangler d1 execute DB --remote --env staging --json --command ${sql}`.cwd(WEB).quiet().text();

const person = async (browser: Browser, email: string, landing = "/desk") => {
  const ctx = await browser.newContext({
    recordVideo: { dir: `${MEDIA}/raw/${email.split("@")[0]}-${Date.now()}`, size: VIEWPORT },
    viewport: VIEWPORT,
  });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  const seg = new Seg(page);
  await seg.off(async () => {
    await page.goto(await loginUrl(email, landing), { timeout: 90_000, waitUntil: "networkidle" });
    await page.waitForTimeout(3500);
  });
  return { ctx, page, seg };
};

const finish = async (p: Awaited<ReturnType<typeof person>>, out: string) => {
  const endMs = p.seg.markEnd();
  const video = p.page.video();
  await p.ctx.close();
  if (!video) {
    throw new Error("no video");
  }
  const raw = await video.path();
  const sorted = [...p.seg.cuts].sort((a, b) => a.startMs - b.startMs);
  const keep: Range[] = [];
  let at = 0;
  for (const cut of sorted) {
    if (cut.startMs > at) {
      keep.push({ endMs: cut.startMs, startMs: at });
    }
    at = Math.max(at, cut.endMs);
  }
  keep.push({ endMs, startMs: at });
  const select = keep.map((r) => `between(t,${r.startMs / 1000},${r.endMs / 1000})`).join("+");
  await $`ffmpeg -y -v error -i ${raw} -vf ${`select='${select}',setpts=N/FRAME_RATE/TB`} -an -c:v libx264 -pix_fmt yuv420p -crf 22 -preset medium ${out}`;
};

const main = async () => {
  await rm(`${MEDIA}/raw`, { force: true, recursive: true });
  // Put the agents back as they were, so the video shows the change being made.
  await remote(`update agents set owner_user_id=null, backup_user_id=null where id in ('${COS}','${CHASER}')`);
  await mkdir(`${MEDIA}/screens`, { recursive: true });
  await mkdir(`${MEDIA}/parts`, { recursive: true });
  const browser = await chromium.launch();
  const parts: string[] = [];

  // Nina: a new workspace, no key and no agents. KEEP_FIRST_DAY reuses part 1 and its results.
  if (process.env.KEEP_FIRST_DAY === "1") {
    const before = (await Bun.file(`${MEDIA}/acceptance.json`).json()) as typeof results;
    results.push(...before.slice(0, 5));
  } else {
  const nina = await person(browser, NINA);
  await scene("first day", async () => {
    const { page, seg } = nina;
    await seg.cap("A brand new workspace. There's no empty board. Two things need Nina, in the same place all her work will land.", 4600);
    await seg.shot("01-first-day");
    const body = await bodyText(page);
    check("New workspace shows both setup steps", body.includes("Add your AI account") && body.includes("Describe your first job"));
    await seg.click(page.getByRole("link", { name: /Describe your first job/ }));
    await seg.wait(() => page.waitForURL(/agents\/new/));
    await seg.wait(() => page.locator("textarea").first().waitFor());
    await seg.cap("She skips ahead and describes the job first.", 2000);
    await seg.fill(page.locator("textarea").first(), "Sort the studio's incoming mail, write replies for me to approve, and tell me what needs a human today.");
    await seg.click(page.getByRole("button", { exact: true, name: "Draft" }));
    const link = page.locator('main a[href*="model-providers"], section a[href*="model-providers"]');
    await seg.wait(() => link.first().waitFor({ timeout: 60_000 }));
    await seg.cap("No key yet. The error used to be a dead end. Now it links straight to the setting.", 3400);
    await seg.shot("02-key-link");
    check("Missing-key error links to the setting", (await link.count()) > 0);
    await seg.click(link);
    await seg.wait(() => page.locator("#managed-api-key").waitFor());
    await page.locator("#managed-api-key").fill(env.ANTHROPIC_API_KEY ?? "");
    await seg.click(page.getByRole("button", { name: "Save key" }).first());
    await seg.wait(() => page.getByText("Key saved").first().waitFor({ timeout: 30_000 }));
    await page.waitForTimeout(600);
    const gone = await pollUntil(async () => (await page.getByRole("link", { name: /Add your AI account/ }).count()) === 0, 25_000, 1500);
    check("Setup step leaves the rail once done", gone);
    await seg.cap("The key is in, and that step leaves the rail.", 2400);
    await seg.click(page.getByRole("link", { name: /Describe your first job/ }));
    await seg.wait(() => page.locator("textarea").first().waitFor());
    await page.waitForTimeout(500);
    const kept = await page.locator("textarea").first().inputValue();
    check("Builder keeps the description across Settings", kept.includes("studio"));
    await seg.cap("Her description survived the trip to Settings. She used to lose it.", 3000);
    await seg.click(page.getByRole("button", { exact: true, name: "Draft" }));
    await seg.wait(() => page.getByRole("button", { name: "Create agent" }).waitFor({ timeout: SLOW }));
    const address = page.locator("input:visible").nth(1);
    await address.fill(`firstday-desk-${Date.now() % 1000}`);
    await page.waitForTimeout(800);
    await seg.click(page.getByRole("button", { exact: true, name: "Cloudflare" }));
    await seg.click(page.getByRole("button", { name: "Create agent" }));
    await seg.wait(() => page.waitForURL(/agents\/[0-9A-Z]{20,}/, { timeout: 60_000 }));
    await page.waitForTimeout(800);
    await seg.goto("/desk");
    await seg.cap("Done. The list is empty, and it says so.", 2800);
    await seg.shot("03-set-up");
    check("Both setup steps gone after setup", (await page.getByRole("link", { name: /AI account|first job/ }).count()) === 0);
  });
  await finish(nina, `${MEDIA}/parts/1.mp4`);
  }
  parts.push(`${MEDIA}/parts/1.mp4`);

  // Clear what earlier runs left waiting on Dan.
  const tidy = await browser.newContext({ viewport: VIEWPORT });
  const tidyPage = await tidy.newPage();
  await tidyPage.goto(await loginUrl(DAN, "/desk"), { timeout: 90_000, waitUntil: "networkidle" });
  await tidyPage.waitForTimeout(3500);
  for (let i = 0; i < 6; i += 1) {
    const no = tidyPage.getByRole("button", { name: "Not this time" });
    // biome-ignore lint/performance/noAwaitInLoops: one at a time
    if (!(await no.count())) {
      break;
    }
    await no.first().click();
    await tidyPage.waitForTimeout(2500);
  }
  await tidy.close();

  // Priya: agents, who they ask, and a day's mail.
  const priya = await person(browser, PRIYA);
  await priya.seg.off(async () => {
    const { page } = priya;
    for (let i = 0; i < 6; i += 1) {
      const dismiss = page.getByRole("button", { name: "Dismiss" });
      // biome-ignore lint/performance/noAwaitInLoops: one at a time
      if (!(await dismiss.count())) {
        break;
      }
      await dismiss.first().click();
      await page.waitForTimeout(2500);
    }
    for (let i = 0; i < 8; i += 1) {
      const no = page.getByRole("button", { name: "Not this time" });
      // biome-ignore lint/performance/noAwaitInLoops: one at a time
      if (!(await no.count())) {
        break;
      }
      await no.first().click();
      await page.waitForTimeout(2500);
    }
    await page.goto(`${BASE}/agents/${CHASER}?sheet=edit`, { waitUntil: "networkidle" });
    const dialog = page.locator("[role=dialog]");
    const instructions = dialog.locator("textarea").first();
    const current = await instructions.inputValue();
    if (!current.includes("never stop to verify")) {
      await instructions.fill(current + CHASER_RULE);
      await dialog.getByRole("button", { name: /^Save/ }).click();
      await page.waitForTimeout(1500);
    }
    await page.goto(`${BASE}/agents`, { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
  });
  await scene("who it asks", async () => {
    const { page, seg } = priya;
    await seg.cap("Northbank is a real company now. Several people, several agents. So each agent asks one person.", 3600);
    await seg.shot("04-agents");
    await seg.click(page.getByRole("link", { name: /Invoice Chaser/ }));
    await seg.wait(() => page.getByLabel("Owner").waitFor());
    await page.waitForTimeout(500);
    await seg.click(page.getByLabel("Owner"));
    await seg.click(page.getByRole("option", { name: "Dan Hughes" }));
    await seg.wait(() => page.waitForTimeout(1500));
    await seg.cap("Invoice Chaser asks Dan, who runs finance.", 2400);
    await seg.shot("05-asks");
    await seg.goto(`/agents/${COS}`);
    await seg.wait(() => page.getByLabel("Backup").waitFor());
    await page.waitForTimeout(500);
    await seg.click(page.getByLabel("Backup"));
    await seg.click(page.getByRole("option", { name: "Dan Hughes" }));
    await seg.wait(() => page.waitForTimeout(1500));
    await seg.cap("Chief of Staff asks Priya, with Dan as her backup if nobody answers in 4 hours.", 3200);
    const overview = await (async () => {
      await page.goto(`${BASE}/agents`, { waitUntil: "networkidle" });
      await page.waitForTimeout(800);
      return bodyText(page);
    })();
    check("Agents table shows the new owner", overview.includes("Dan Hughes"));
  });
  await scene("mail arrives", async () => {
    const { page, seg } = priya;
    await seg.goto("/desk");
    await seg.cap("Off camera, four emails arrive through real Cloudflare mail. The wait is cut.", 2600);
    await seg.off(async () => {
      await sendMail(browser, BATCH_A, 4);
      await pollUntil(async () => {
        await page.goto(`${BASE}/desk`, { waitUntil: "networkidle" });
        await page.waitForTimeout(2500);
        const text = await bodyText(page);
        const mine = Number(text.match(/Mine\s*(\d+)/)?.[1] ?? 0);
        const everyone = Number(text.match(/Everyone\s*(\d+)/)?.[1] ?? 0);
        const settled = !/\nWorking\n/.test(text);
        const grouped = /\+1|1 more/.test(text);
        return mine >= 2 && everyone > mine && settled && grouped;
      }, 360_000, 8000);
      await page.goto(`${BASE}/desk`, { waitUntil: "networkidle" });
      await page.waitForTimeout(2500);
    });
    await page.waitForTimeout(800);
    await seg.cap("This is Priya's day. Plain titles, what's due first, and only what's hers.", 4000);
    await seg.shot("06-mine");
    const text = await bodyText(page);
    check("No mail task shows the quoted JSON title", !text.includes("quoted JSON"));
    check("Due work sorts first", (await rows(page).first().innerText()).toLowerCase().includes("forecast") || (await rows(page).first().innerText()).toLowerCase().includes("fee"), await rows(page).first().innerText());
    check("Two mails to Kestrel group into one row", text.includes("+1") || text.includes("1 more"), (await rows(page).first().innerText()).replace(/\n/g, " "));
  });
  await scene("deciding", async () => {
    const { page, seg } = priya;
    const grouped = rows(page).filter({ hasText: /\+1|1 more/ });
    await seg.click((await grouped.count()) ? grouped : rows(page).first());
    await seg.wait(() => page.locator('[data-testid="mail-decision"]').first().waitFor());
    await page.waitForTimeout(500);
    await seg.cap("Who it goes to, what they wrote, and the reply. It used to be headed Use mail_send, in a code font.", 4600);
    await seg.shot("07-decision");
    const fontFamily = await page.locator('[data-testid="mail-reply"]').first().evaluate((el) => getComputedStyle(el).fontFamily);
    check("Reply is not in a monospace font", !/mono|courier|consolas/i.test(fontFamily), fontFamily);
    const rawTool = await page.evaluate(() => {
      // The video caption mentions the old heading, so it is skipped.
      const hits: string[] = []; const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let node = walk.nextNode(); while (node) { if (node.textContent?.includes("mail_send") && !node.textContent.includes("It used to be")) { hits.push(`${node.parentElement?.tagName} ${node.textContent.slice(0, 80)}`); } node = walk.nextNode(); } return hits; });
    check("No raw tool heading on the decision", rawTool.length === 0, rawTool.join(" | "));
    const cards = await page.locator('[data-testid="mail-decision"]').count();
    check("Grouped row opens both replies", cards >= 2, `${cards} cards`);
    await seg.click(page.getByRole("button", { name: "Send reply" }).first());
    await seg.wait(() => page.waitForTimeout(2500));
    await seg.cap("Send reply is one click. The list moves on by itself.", 3000);
    check("Answered card leaves the pane", (await page.locator('[data-testid="mail-decision"]').count()) < cards || cards === 1);
  });
  await scene("holds still", async () => {
    const { page, seg } = priya;
    await seg.click(rows(page).last());
    await seg.wait(() => page.locator('[data-testid="rail-card"]').first().waitFor());
    await page.waitForTimeout(600);
    const before = (await rows(page).allInnerTexts()).map((t) => t.split("\n")[0]);
    const openHref = await page.evaluate(() => location.search);
    const openIndex = before.length - 1;
    const heading = await page.locator("h1,h2").first().innerText();
    await seg.cap("Priya is reading this one when a new email comes in, and it's marked for today.", 3200);
    await seg.off(async () => {
      await sendMail(browser, BATCH_B, 1);
      await pollUntil(async () => (await rows(page).count()) > before.length, 200_000);
    });
    await page.waitForTimeout(800);
    await seg.cap("The new row lands in the list, but what she's reading doesn't jump.", 3800);
    await seg.shot("08-holds-still");
    const after = (await rows(page).allInnerTexts()).map((t) => t.split("\n")[0]);
    check("A new row arrived", after.length > before.length, after.join(" | "));
    check("The open row keeps its place", after[openIndex] === before[openIndex], `${before[openIndex]} / ${after[openIndex]}`);
    check("The pane keeps the same item", (await page.evaluate(() => location.search)) === openHref && (await page.locator("h1,h2").first().innerText()) === heading);
    const allow = await page.getByRole("button", { name: "Not this time" }).count();
    if (allow) {
      await seg.click(page.getByRole("button", { name: "Tell it what to change" }).first());
      await page.getByLabel("Tell it what to change").first().fill("Check with Sam first, then try again.");
      await seg.cap("She can also say no, and tell it what to change.", 2600);
      await seg.click(page.getByRole("button", { name: "Not this time" }).first());
      await seg.wait(() => page.waitForTimeout(2500));
    }
  });
  await scene("everyone", async () => {
    const { page, seg } = priya;
    await seg.click(page.getByRole("button", { name: /^Everyone/ }));
    await seg.wait(() => page.waitForTimeout(2000));
    await seg.cap("Everyone shows what's waiting across the company, and who each thing is for.", 3600);
    await seg.shot("09-everyone");
    const text = await bodyText(page);
    check("Everyone names who an item is for", text.includes("for Dan"));
    await seg.click(page.getByRole("button", { name: /^Mine/ }));
    await page.waitForTimeout(1200);
    const mine = await bodyText(page);
    check("Mine hides Dan's work", !mine.includes("for Dan"));
  });
  await finish(priya, `${MEDIA}/parts/2.mp4`);
  parts.push(`${MEDIA}/parts/2.mp4`);

  // Dan: his own view, then escalation.
  const dan = await person(browser, DAN);
  await scene("dan", async () => {
    const { page, seg } = dan;
    await seg.cap("Now Dan signs in. Same company, and he sees only the invoice reminder that's his.", 4000);
    await seg.shot("10-dan");
    const first = rows(page).first();
    check("Dan's Mine holds his agent's work", (await first.count()) > 0 && /brightwell|invoice|inv-|reminder|overdue/i.test(await first.innerText()), await first.innerText().catch(() => "none"));
    check("Dan does not see Priya's Kestrel replies", !/kestrel|forecast/i.test((await rows(page).allInnerTexts()).join(" ")));
    check("Passed-on work says who passed it", (await bodyText(page)).toLowerCase().includes("passed on by"));
    await seg.hover(page.getByRole("button", { name: "Send reply" }).first(), 1000);
  });
  await scene("escalation", async () => {
    const { page, seg } = dan;
    await seg.off(async () => {
      const ORG = (await Bun.file("/tmp/hm-review/final-org.txt").text()).trim();
      const stamp = new Date(Date.now() - 5 * 60 * 60_000).toISOString();
      await remote(
        `update run_requests set created_at='${stamp}' where agent_id='${COS}' and answered_at is null and id=(select id from run_requests where agent_id='${COS}' and answered_at is null and workspace_id=(select id from workspaces where clerk_org_id='${ORG}') order by created_at desc limit 1)`
      );
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForTimeout(2500);
    });
    await seg.cap("One of Priya's replies has now waited over 4 hours. We aged it by hand for this video. It also appears for Dan, her backup.", 5000);
    await seg.shot("11-escalated");
    check("An item over 4 hours reaches the backup", (await bodyText(page)).includes("asked you too"));
  });
  await finish(dan, `${MEDIA}/parts/3.mp4`);
  parts.push(`${MEDIA}/parts/3.mp4`);

  // Priya again: stuck work, and everything else.
  const again = await person(browser, PRIYA);
  await scene("stuck", async () => {
    const { page, seg } = again;
    const problem = rows(page).filter({ hasText: /bounced/i });
    await seg.off(() => pollUntil(async () => {
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForTimeout(1500);
      return (await problem.count()) > 0;
    }, 120_000, 6000));
    await seg.cap("When something goes wrong it comes to her too. The reply she sent went to a test address, and it bounced.", 4200);
    check("A bounced mail reaches Needs you", (await problem.count()) > 0);
    await seg.click(problem);
    await seg.wait(() => page.locator('[data-testid="problem-body"]').first().waitFor());
    await page.waitForTimeout(500);
    await seg.shot("12-problem");
    const words = await page.locator('[data-testid="problem-body"]').first().innerText();
    check("The problem says what bounced", /Mail to .+ bounced/.test(words), words.split("\n")[0]);
    await seg.cap("It stays until someone deals with it.", 2400);
    const count = await problem.count();
    await seg.click(page.getByRole("button", { name: "Dismiss" }));
    await seg.wait(() => page.waitForTimeout(2500));
    check("Dismiss clears the problem", (await problem.count()) < count);
  });
  await scene("everything else", async () => {
    const { page, seg } = again;
    await seg.click(page.getByRole("link", { name: "Agents", exact: true }).last());
    await seg.wait(() => page.waitForURL(/\/agents$/));
    await page.waitForTimeout(900);
    await seg.cap("Agents shows who asks whom, what each is doing, and what it cost this week.", 3400);
    await seg.shot("13-agents-after");
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(600);
    await seg.cap("Nothing was removed. Ctrl K finds every page, every agent and every setting.", 3600);
    await seg.shot("14-find");
    const dialog = await page.locator("[role=dialog]").innerText();
    check("Find lists the old pages", ["Map", "Skills", "Log", "Routines", "Triggers", "Secrets", "API keys"].every((p) => dialog.includes(p)));
    await page.keyboard.type("log", { delay: 90 });
    await page.waitForTimeout(600);
    await page.keyboard.press("Enter");
    await seg.wait(() => page.waitForURL(/\/log/));
    await page.waitForTimeout(800);
    await seg.goto("/desk?view=board");
    await seg.cap("The old board is still here too, one click from the done count.", 3200);
    await seg.shot("15-board");
    check("Board view still works", (await bodyText(page)).includes("Done today"));
    check("Board has no quoted JSON titles", !(await bodyText(page)).includes("quoted JSON"));
    await seg.goto("/desk");
    await seg.cap("The work comes to you. The rest stays out of the way.", 3200);
  });
  await finish(again, `${MEDIA}/parts/4.mp4`);
  parts.push(`${MEDIA}/parts/4.mp4`);

  // Phone, not in the video.
  const phone = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { height: 844, width: 390 } });
  const mobile = await phone.newPage();
  await mobile.goto(await loginUrl(PRIYA, "/desk"), { timeout: 90_000, waitUntil: "networkidle" });
  await mobile.waitForTimeout(3500);
  await mobile.screenshot({ path: `${MEDIA}/screens/16-phone.png` });
  check("Phone shows the list inline", (await mobile.locator('[data-testid="inline-list"]').count()) > 0 || (await rows(mobile).count()) > 0);
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check("Phone has no sideways scroll", !overflow);
  await phone.close();
  await browser.close();

  await Bun.write(`${MEDIA}/acceptance.json`, `${JSON.stringify(results, null, 2)}\n`);
  const inputs = parts.flatMap((p) => ["-i", p]);
  const filter = `${parts.map((_, i) => `[${i}:v]`).join("")}concat=n=${parts.length}:v=1[v]`;
  await $`ffmpeg -y -v error ${inputs} -filter_complex ${filter} -map [v] -c:v libx264 -pix_fmt yuv420p -crf 22 -preset medium ${MEDIA}/harbourmaster-rail.mp4`;
  const failed = results.filter((r) => !r.pass);
  console.log(`${results.length - failed.length} of ${results.length} checks passed`);
};

await main();
