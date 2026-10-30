#!/usr/bin/env bun
import { mkdir, rm } from "node:fs/promises";
import { parseEnv } from "node:util";
// Records the Northbank Advisory walkthrough on staging as one silent Playwright
// video with burned-in captions, per script.md. Waits are cut, so the video runs
// faster than real life, and scene wall-clock times go to timings.json.
// Run from this folder: bun record.ts
// Needs an empty workspace (provision-final.ts) and the Client Mail Sim agent.
import { $ } from "bun";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Locator,
  type Page,
} from "playwright";

const BASE = "https://harbourmaster-staging.rockyshoreslabs.io";
const PRIYA = "priya@office.northbank.rockyshoreslabs.io";
const SIM = "ux-sim@rockyshoreslabs.io";
const SIM_AGENT = "01M65WDB47F5MJYWYQ8JGQ38QZ";
const COS_ADDRESS = "northbank-office";
const MEDIA = `${import.meta.dir}/../media`;
const RAW = `${MEDIA}/raw`;
const SCREENS = `${MEDIA}/screens`;
const WEB = `${import.meta.dir}/../../../apps/web`;
const VIEWPORT = { height: 900, width: 1440 };
const KEEP_MS = 500;
const SLOW_MS = 240_000;

const COS_BRIEF =
  "You are the chief of staff for Northbank Advisory, a nine-person consulting firm. Read the mail that comes in to the office. It arrives through a forwarding address, so treat the Originally from line at the top as the real sender. Sort each message into client work, invoices and admin, or noise. For client work, write a reply with the mail tool, which holds it for a person to approve, and say who on the team should own it. Pass overdue invoices to the invoice agent. Every weekday at 8am post a short briefing of what needs a human today.";

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
  cap.id = "__cap";
  Object.assign(cap.style, { position: "fixed", left: "50%", bottom: "24px", transform: "translateX(-50%)", maxWidth: "1040px",
    padding: "10px 18px", borderRadius: "10px", background: "rgba(20,20,20,.88)", color: "#fff", font: "500 19px/1.35 system-ui,sans-serif",
    textAlign: "center", zIndex: 2147483646, pointerEvents: "none" });
  document.body.appendChild(cap);
  window.__setCap = (t) => { cap.textContent = t; cap.style.display = t ? "block" : "none"; };
  window.__setCap(sessionStorage.getItem("__cap") || "");
});`;

const loginUrl = async (email: string, redirect: string) => {
  const out =
    await $`bun run agent-login --env staging --email ${email} --redirect ${redirect}`
      .cwd(WEB)
      .quiet()
      .text();
  const url = out.trim().split("\n").at(-1);
  if (!url?.startsWith("http")) {
    throw new Error("agent-login printed no URL");
  }
  return url;
};

interface Cut {
  endMs: number;
  startMs: number;
}

class Rec {
  readonly cuts: Cut[] = [];
  readonly scenes: { id: string; startMs: number; wallMs?: number }[] = [];
  private pointer = { x: 720, y: 450 };
  private readonly origin = Date.now();
  private shotCount = Number(process.env.SHOT_START ?? 0);

  constructor(readonly page: Page) {}

  private now = () => Date.now() - this.origin;

  scene(id: string) {
    const last = this.scenes.at(-1);
    if (last) {
      last.wallMs = this.now() - last.startMs;
    }
    this.scenes.push({ id, startMs: this.now() });
    console.log(`scene ${id}`);
  }

  async cap(text: string, holdMs = 3200) {
    await this.page
      .evaluate((t) => {
        sessionStorage.setItem("__cap", t);
        (window as unknown as { __setCap?: (s: string) => void }).__setCap?.(t);
      }, text)
      .catch(() => undefined);
    await this.page.waitForTimeout(holdMs);
  }

  async wait<T>(work: () => Promise<T>, keepMs = KEEP_MS): Promise<T> {
    const startMs = this.now();
    const result = await work();
    const endMs = this.now() - keepMs;
    if (endMs > startMs) {
      this.cuts.push({ endMs, startMs });
    }
    return result;
  }

  offscreen<T>(work: () => Promise<T>) {
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
      target.first().waitFor({ state: "visible", timeout: SLOW_MS })
    );
    await target.first().scrollIntoViewIfNeeded();
    const box = await target.first().boundingBox();
    if (!box) {
      throw new Error(`No box for ${target}`);
    }
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const distance = Math.hypot(x - this.pointer.x, y - this.pointer.y);
    await this.page.mouse.move(x, y, {
      steps: Math.max(8, Math.round(distance / 30)),
    });
    this.pointer = { x, y };
  }

  async click(target: Locator) {
    await this.glide(target);
    await this.page.waitForTimeout(220);
    await target.first().click();
    await this.page.waitForTimeout(350);
  }

  async hover(target: Locator, holdMs = 900) {
    await this.glide(target);
    await this.page.waitForTimeout(holdMs);
  }

  async fill(target: Locator, text: string) {
    await this.click(target);
    await target.first().fill(text);
    await this.page.waitForTimeout(250);
  }

  async type(target: Locator, text: string) {
    await this.click(target);
    await target.first().fill("");
    await target.first().pressSequentially(text, { delay: 35 });
  }

  /** Scrolls the page in steps, so the viewer can read along. */
  async scroll(px: number) {
    const steps = Math.max(1, Math.round(Math.abs(px) / 90));
    for (let i = 0; i < steps; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: paced on purpose
      await this.page.mouse.wheel(0, Math.sign(px) * 90);
      await this.page.waitForTimeout(110);
    }
    await this.page.waitForTimeout(400);
  }

  async shot(name: string, fullPage = false) {
    this.shotCount += 1;
    const file = `${SCREENS}/${String(this.shotCount).padStart(2, "0")}-${name}.png`;
    await this.offscreen(async () => {
      await this.page.evaluate(() =>
        (window as unknown as { __setCap?: (s: string) => void }).__setCap?.("")
      );
      const y = await this.page.evaluate(() => {
        const at = window.scrollY;
        window.scrollTo(0, 0);
        return at;
      });
      await this.page.screenshot({ fullPage, path: file });
      await this.page.evaluate((to) => window.scrollTo(0, to), y);
      await this.page.evaluate(() =>
        (window as unknown as { __setCap?: (s: string) => void }).__setCap?.(
          sessionStorage.getItem("__cap") || ""
        )
      );
    });
  }

  finishScenes() {
    const last = this.scenes.at(-1);
    if (last) {
      last.wallMs = this.now() - last.startMs;
    }
    return { cuts: this.cuts, endMs: this.now(), scenes: this.scenes };
  }
}

const envLocal = parseEnv(await Bun.file(`${WEB}/.env.local`).text());

/** Sends the five test emails from the sim workspace and approves them there. */
const sendSimulatedMail = async (browser: Browser, to: string) => {
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  const page = await ctx.newPage();
  await page.goto(await loginUrl(SIM, `/agents/${SIM_AGENT}`), {
    timeout: 90_000,
    waitUntil: "networkidle",
  });
  await page.waitForTimeout(3000);
  const emails = (
    await Bun.file(`${import.meta.dir}/emails.md`).text()
  ).replaceAll("chief-of-staff@rockyshoreslabs.io", to);
  await page.getByRole("button", { name: "Run now" }).click();
  const dialog = page.locator("[role=dialog]");
  await dialog.locator("textarea").fill(emails);
  await dialog.getByRole("button", { name: "Start task" }).click();
  let approved = 0;
  for (let i = 0; i < 60 && approved < 5; i += 1) {
    const allow = page.getByRole("button", { name: "Allow once" });
    // biome-ignore lint/performance/noAwaitInLoops: one approval at a time
    if (await allow.count()) {
      await allow.first().click();
      approved += 1;
      await page.waitForTimeout(2500);
    } else {
      await page.waitForTimeout(3000);
    }
  }
  console.log(`simulated mail approved: ${approved}`);
  await ctx.close();
};

const draftAndCreate = async (
  rec: Rec,
  opts: { address?: string; name?: string }
) => {
  const { page } = rec;
  await rec.click(page.getByRole("button", { exact: true, name: "Draft" }));
  await rec.wait(() =>
    page
      .getByRole("button", { name: "Create agent" })
      .waitFor({ timeout: SLOW_MS })
  );
  if (opts.name) {
    await page.locator("input:visible").first().fill(opts.name);
  }
  if (opts.address) {
    await rec.type(page.locator("input:visible").nth(1), opts.address);
  }
};

const scenes = async (rec: Rec, browser: Browser) => {
  const { page } = rec;
  const dialog = page.locator("[role=dialog]");
  const closeDialog = () =>
    rec.click(dialog.getByRole("button", { name: "Close" }).first());
  const sidebarLink = (name: string) =>
    page
      .locator('[data-slot="sidebar"]')
      .getByRole("link", { exact: true, name });

  // RESUME=1 picks up after the approval in s11, for a run that stopped there.
  if (process.env.RESUME === "1") {
    rec.scene("s11b");
    await rec.goto("/desk");
  } else {
    rec.scene("s01");
    await rec.cap(
      "Priya signs in for the first time. The Desk is empty, and nothing says what to do first.",
      3600
    );
    await rec.shot("cold-desk");
    await rec.hover(sidebarLink("Agents"), 400);
    await rec.hover(sidebarLink("Library"), 400);
    await rec.click(page.getByText("More", { exact: true }));
    await rec.cap(
      "The sidebar already lists thirteen places, plus Settings.",
      3000
    );
    await rec.shot("cold-sidebar-open");

    rec.scene("s02");
    await rec.click(page.getByRole("button", { name: "New task" }));
    await rec.cap(
      "New task can't start without an agent, so she goes to New agent.",
      2600
    );
    await rec.shot("new-task-no-agents");
    await closeDialog();
    await rec.click(page.getByRole("link", { name: "New agent" }).last());
    await rec.wait(() => page.waitForURL(/agents\/new/));
    await rec.cap(
      "She describes the job in plain words and presses Draft.",
      1600
    );
    await rec.fill(page.locator("textarea").first(), COS_BRIEF);
    await rec.click(page.getByRole("button", { exact: true, name: "Careful" }));
    await rec.click(page.getByRole("button", { exact: true, name: "Draft" }));
    await rec.wait(() =>
      page.getByText("no Anthropic API key").waitFor({ timeout: 90_000 })
    );
    await rec.cap(
      "The workspace has no Anthropic key. The error names the setting but has no link, and she has no idea what a key is.",
      4600
    );
    await rec.shot("draft-needs-key");

    rec.scene("s03");
    await rec.click(sidebarLink("Settings"));
    await rec.wait(() => page.waitForURL(/settings/));
    await rec.wait(() => page.locator("#managed-api-key").waitFor());
    await rec.cap(
      "Settings has seven pages under three headings. Model providers is first.",
      3000
    );
    await rec.shot("settings-model-providers");
    await rec.cap(
      "A non-technical owner now needs an Anthropic console account and a billing setup before seeing any value.",
      3400
    );
    await rec.click(page.locator("#managed-api-key"));
    await page
      .locator("#managed-api-key")
      .fill(envLocal.ANTHROPIC_API_KEY ?? "");
    await rec.click(page.getByRole("button", { name: "Save key" }).first());
    await rec.wait(() =>
      page.getByText("Key saved").first().waitFor({ timeout: 30_000 })
    );
    await page.waitForTimeout(900);

    rec.scene("s04");
    await rec.click(sidebarLink("New agent"));
    await rec.wait(() => page.locator("textarea").first().waitFor());
    await rec.cap(
      "The description didn't survive the trip to Settings, so she pastes it again.",
      2800
    );
    await rec.fill(page.locator("textarea").first(), COS_BRIEF);
    await rec.click(page.getByRole("button", { exact: true, name: "Careful" }));
    await draftAndCreate(rec, {});
    await rec.cap(
      "This is the best moment in the product. Seconds later there is a named agent with rules, a schedule and a mail address.",
      4000
    );
    await rec.shot("draft-result", true);
    await rec.cap(
      "Mail addresses are shared across every workspace on this domain, so Priya picks one that isn't taken.",
      2400
    );
    await rec.type(page.locator("input:visible").nth(1), COS_ADDRESS);
    await rec.scroll(520);
    await rec.cap(
      "The left panel leaks the plumbing, though. A cron string, and a build task number: V5.",
      4000
    );

    rec.scene("s05");
    await rec.click(page.getByRole("button", { name: "Run the dry run" }));
    await rec.cap(
      "The dry run tries the agent on a sample email, with nothing saved or sent.",
      2200
    );
    await rec.wait(async () => {
      const running = page.getByText("Running", { exact: true }).first();
      await running.waitFor({ state: "visible", timeout: 30_000 });
      await running.waitFor({ state: "hidden", timeout: SLOW_MS });
    });
    await page.waitForTimeout(600);
    await rec.hover(
      page.getByRole("button", { name: /Run the dry run again/ }),
      300
    );
    await rec.scroll(-260);
    await rec.cap(
      (await page.locator("body").innerText()).match(
        /roster|team list|who is on the team/i
      )
        ? "It answers well, and it asks for a team roster. That's useful. The receipt around the answer reads like a developer's log."
        : "It answers well, and it says what it doesn't know. The receipt around the answer reads like a developer's log.",
      4600
    );
    await rec.shot("dry-run-result", true);

    rec.scene("s06");
    await rec.scroll(-300);
    await rec.cap(
      "Runs on offers Anthropic cloud or Cloudflare. Nothing helps her choose, and the model isn't here at all.",
      3800
    );
    await rec.click(
      page.getByRole("button", { exact: true, name: "Cloudflare" })
    );
    await rec.click(page.getByRole("button", { name: "Create agent" }));
    await rec.wait(() =>
      page.waitForURL(/agents\/[0-9A-Z]{20,}/, { timeout: 60_000 })
    );
    const cosUrl = page.url().replace(BASE, "");
    await page.waitForTimeout(1200);
    await rec.cap(
      `The profile puts everything on one page, which is good. It also says the 8am briefing runs on ${(await page.locator("body").innerText()).match(/weekdays at 08:00 ([A-Za-z_/]+)/)?.[1] ?? "a default"} time, and Priya is in Sydney.`,
      4600
    );
    await rec.shot("profile", true);
    await rec.click(page.getByRole("button", { exact: true, name: "Edit" }));
    await rec.wait(() => dialog.locator("select").first().waitFor());
    await rec.cap(
      "The model sits behind Edit, next to a paragraph about isolates, VMs and short-lived sandboxes.",
      4200
    );
    await rec.shot("edit-sheet");
    await dialog.locator("select").first().selectOption("haiku");
    await page.waitForTimeout(500);
    await rec.click(dialog.getByRole("button", { name: /^Save/ }));
    await rec.wait(() => page.waitForTimeout(1800));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    rec.scene("s07");
    await rec.click(sidebarLink("New agent"));
    await rec.wait(() => page.locator("textarea").first().waitFor());
    await rec.click(page.getByRole("button", { name: "Chase late invoices" }));
    await rec.cap("The template fills the description in one click.", 2200);
    await draftAndCreate(rec, {
      address: "northbank-accounts",
      name: "Invoice Chaser",
    });
    await rec.click(
      page.getByRole("button", { exact: true, name: "Cloudflare" })
    );
    await rec.click(page.getByRole("button", { name: "Create agent" }));
    await rec.wait(() =>
      page.waitForURL(/agents\/[0-9A-Z]{20,}/, { timeout: 60_000 })
    );
    await page.waitForTimeout(800);
    const chaserUrl = page.url().replace(BASE, "");
    await rec.offscreen(async () => {
      await page.goto(`${BASE}${chaserUrl}?sheet=edit`, {
        waitUntil: "networkidle",
      });
      await dialog.locator("select").first().selectOption("haiku");
      await dialog.getByRole("button", { name: /^Save/ }).click();
      await page.waitForTimeout(1500);
    });
    await rec.goto(cosUrl);
    await rec.click(page.getByRole("button", { name: "Manage" }).first());
    await rec.wait(() => dialog.getByText("Invoice Chaser").first().waitFor());
    await rec.cap(
      "Hand-offs live under a Manage button on the profile, and also on the Map.",
      3000
    );
    await rec.click(
      dialog.locator("[role=switch],[role=checkbox],input[type=checkbox]")
    );
    await page.waitForTimeout(1200);
    await rec.shot("hands-to");
    await closeDialog();

    rec.scene("s08");
    await rec.click(sidebarLink("Library"));
    await rec.wait(() =>
      page.getByRole("button", { name: "New page" }).waitFor()
    );
    await rec.cap(
      "The agent asked for a roster, so Priya adds one to the wiki. Agents can read the wiki by default.",
      3000
    );
    await rec.click(page.getByRole("button", { name: "New page" }));
    await rec.type(dialog.locator("input:visible").first(), "Team");
    await rec.click(dialog.getByRole("button", { name: "Create page" }));
    await rec.wait(() =>
      page.getByRole("button", { exact: true, name: "Edit" }).waitFor()
    );
    await page.waitForTimeout(600);
    await rec.click(page.getByRole("button", { exact: true, name: "Edit" }));
    const team = await Bun.file(`${import.meta.dir}/team.md`).text();
    await rec.wait(() => page.locator("textarea:visible").first().waitFor());
    await rec.fill(page.locator("textarea:visible").first(), team);
    await rec.click(page.getByRole("button", { name: /^Save/ }));
    await rec.wait(() => page.waitForTimeout(1800));
    await rec.shot("wiki-team");

    rec.scene("s09");
    await rec.goto("/settings/connectors");
    await rec.click(page.getByRole("button", { name: "Add connector" }));
    await rec.cap(
      "Connections start from a blank form asking for a server URL. There's no list of apps, and no Gmail or Google Calendar button.",
      4800
    );
    await rec.shot("add-connector");
    await rec.type(page.locator("#connector-name"), "Cloudflare Docs");
    await rec.fill(
      page.locator("#connector-url"),
      "https://docs.mcp.cloudflare.com/mcp"
    );
    await page.locator("#connector-auth-mode").selectOption({ label: "None" });
    await rec.click(dialog.getByRole("button", { name: "Add connector" }));
    await rec.wait(() =>
      page
        .getByText("search_cloudflare_documentation")
        .first()
        .waitFor({ timeout: 60_000 })
    );
    await rec.shot("connectors-table");
    await rec.goto("/settings/secrets");
    await rec.cap(
      "A secret is a separate page with its own proxy and env rules.",
      3400
    );
    await rec.shot("secrets");
    await rec.goto(cosUrl);
    await rec.click(page.getByRole("button", { name: "Manage" }).nth(1));
    await rec.wait(() => dialog.getByText("Connect Slack").first().waitFor());
    await rec.cap(
      "Slack means leaving for api.slack.com, pasting a manifest and copying two tokens back. It works. Priya would stop here.",
      4800
    );
    await rec.shot("slack-sheet");
    await closeDialog();

    rec.scene("s10");
    await rec.goto("/desk");
    await rec.cap(
      "Off camera, a simulator sends five emails through real Cloudflare mail. The wait is cut.",
      2600
    );
    await rec.offscreen(async () => {
      await sendSimulatedMail(browser, `${COS_ADDRESS}@rockyshoreslabs.io`);
      for (let i = 0; i < 60; i += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: polling the desk
        await page.goto(`${BASE}/desk`, { waitUntil: "networkidle" });
        await page.waitForTimeout(4000);
        const running = await page.getByText("Inbound mail").count();
        const asks = await page
          .getByRole("button", { name: "Allow once" })
          .count();
        const lane = await page
          .getByText("Done today")
          .locator("..")
          .innerText()
          .catch(() => "");
        if (asks >= 1 && running >= 3 && /[3-9]/.test(lane)) {
          break;
        }
        await page.waitForTimeout(6000);
      }
    });
    await rec.cap(
      "The work is real and the Desk is honest. But every mail task is titled Inbound mail, the quoted JSON below is untrusted content.",
      5000
    );
    await rec.shot("desk-working", true);
    await rec.cap(
      "Priya can't tell the board-pack emergency from the newsletter without opening each one.",
      3400
    );

    rec.scene("s11");
    await rec.hover(page.getByRole("button", { name: "Allow once" }), 500);
    await rec.cap(
      "This is what the product is for. A person decides, and the agent waits.",
      3000
    );
    await rec.cap(
      "But the heading says Use mail_send, the reply is in a code font, and it expires in one hour. A mail held at 7pm is gone by the 8am briefing.",
      5200
    );
    await rec.shot("approval-card");
    await rec.click(page.getByRole("button", { name: "Allow once" }));
    await rec.wait(() => page.waitForTimeout(2500));
    await rec.goto("/desk");
    await rec.shot("desk-after-allow", true);
  }
  await rec.click(page.getByText("Inbound mail").last());
  await rec.wait(() => page.waitForURL(/tasks\//, { timeout: 30_000 }));
  await page.waitForTimeout(1200);
  await rec.shot("task-page", true);
  await rec.cap(
    "The task page shows everything. Tool calls, a run id, a cost, an action log and a thread that repeat each other.",
    3600
  );
  await rec.scroll(900);
  await page.waitForTimeout(900);

  rec.scene("s12");
  await rec.click(sidebarLink("Map"));
  await rec.wait(() =>
    page.getByRole("button", { name: "Fit view" }).waitFor()
  );
  await page.waitForTimeout(1500);
  await rec.cap(
    "The map is the clearest picture of the system. It names mail addresses and folders where Priya would think of clients, invoices and briefings.",
    4600
  );
  await rec.shot("map-runs");
  await rec.click(
    page
      .getByRole("button", { name: "Editor" })
      .or(page.getByText("Editor", { exact: true }))
  );
  await page.waitForTimeout(1600);
  await rec.shot("map-editor");

  rec.scene("s13");
  await rec.goto("/qa");
  await rec.cap(
    "Q&A, Inbox and the Desk are three places a person can be asked something.",
    2600
  );
  await rec.shot("qa");
  await rec.goto("/inbox");
  await page.waitForTimeout(1000);
  await rec.shot("inbox");
  await rec.goto("/sessions");
  await rec.cap(
    "Sessions, Log and the Task page are three views of the same runs.",
    2600
  );
  await rec.shot("sessions");
  await rec.goto("/log");
  await page.waitForTimeout(1000);
  await rec.shot("log");
  await rec.goto("/routines");
  await page.waitForTimeout(1100);
  await rec.shot("routines");
  await rec.goto("/triggers");
  await page.waitForTimeout(700);
  await rec.goto("/skills");
  await page.waitForTimeout(900);
  await rec.shot("skills");
  await rec.goto("/artifacts");
  await page.waitForTimeout(900);
  await rec.shot("artifacts");
  await rec.goto("/settings/machines");
  await rec.cap(
    "Every one of these works. The problem is that they all sit at the same level, on the first day.",
    3600
  );
  await rec.shot("machines");
};

const concat = async (
  markers: ReturnType<Rec["finishScenes"]>,
  rawVideo: string,
  target: string
) => {
  const ordered = [...markers.cuts].sort((a, b) => a.startMs - b.startMs);
  const keep: Cut[] = [];
  let at = markers.scenes[0]?.startMs ?? 0;
  for (const cut of ordered) {
    if (cut.startMs > at) {
      keep.push({ endMs: cut.startMs, startMs: at });
    }
    at = Math.max(at, cut.endMs);
  }
  keep.push({ endMs: markers.endMs, startMs: at });
  const select = keep
    .map((r) => `between(t,${r.startMs / 1000},${r.endMs / 1000})`)
    .join("+");
  await $`ffmpeg -y -v error -i ${rawVideo} -vf ${`select='${select}',setpts=N/FRAME_RATE/TB`} -an -c:v libx264 -pix_fmt yuv420p -crf 22 -preset medium ${target}`;
};

const main = async () => {
  await rm(RAW, { force: true, recursive: true });
  const part = process.env.RESUME === "1" ? "-part2" : "";
  await mkdir(SCREENS, { recursive: true });
  await mkdir(`${MEDIA}/out`, { recursive: true });
  const browser = await chromium.launch();
  const ctx: BrowserContext = await browser.newContext({
    recordVideo: { dir: RAW, size: VIEWPORT },
    viewport: VIEWPORT,
  });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  const rec = new Rec(page);
  let failed: unknown;
  try {
    await rec.offscreen(async () => {
      await page.goto(await loginUrl(PRIYA, "/desk"), {
        timeout: 90_000,
        waitUntil: "networkidle",
      });
      await page.waitForTimeout(3500);
    });
    await scenes(rec, browser);
  } catch (error) {
    failed = error;
    await page
      .screenshot({ path: `${MEDIA}/failure.png` })
      .catch(() => undefined);
    console.error(
      "FAILED at",
      rec.scenes.at(-1)?.id,
      page.url(),
      String(error).slice(0, 600)
    );
  }
  await page.waitForTimeout(1500);
  const markers = rec.finishScenes();
  const video = page.video();
  await ctx.close();
  await browser.close();
  await Bun.write(
    `${MEDIA}/timings${part}.json`,
    `${JSON.stringify(markers, null, 2)}\n`
  );
  if (video) {
    const raw = await video.path();
    await concat(
      markers,
      raw,
      `${MEDIA}/out/harbourmaster-walkthrough${part}.mp4`
    );
  }
  if (failed) {
    process.exit(1);
  }
};

await main();
