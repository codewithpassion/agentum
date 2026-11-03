/** biome-ignore-all lint/performance/noAwaitInLoops: Browser contexts and UI actions are ordered acceptance steps. */
/** Real app acceptance: no request interception or substitute callbacks. Run with
 * HM_SERVER=http://localhost:3118 bun apps/web/e2e/live-artifacts.ts.
 * Optional HM_LIVE_ARTIFACT_ID reuses an artifact with an actual agent/change.
 * Otherwise creates a document via the authenticated production service. */
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type BrowserContext,
  chromium,
  expect,
  type Page,
} from "@playwright/test";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { z } from "zod";
import type { LiveArtifactsRouter } from "../src/integrations/trpc/types";

const base = process.env.HM_SERVER ?? "http://localhost:3118";
const evidence = resolve(
  process.env.HM_LIVE_EVIDENCE ?? `/tmp/agentum-l8-browser-${Date.now()}`
);
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true });
const passed: string[] = [];
const gates: string[] = [];
const contexts: BrowserContext[] = [];
const failures: string[] = [];
async function login(page: Page) {
  await page.goto(`${base}/login`);
  const local = page.getByRole("link", { name: "Dev login (local only)" });
  if ((await local.count()) === 0) {
    throw new Error(
      "Real local dev login is unavailable; authenticated acceptance requires a supplied session."
    );
  }
  const loginResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/dev-login"
  );
  await local.click();
  const accepted = await loginResponse;
  if (!accepted.ok() && accepted.status() !== 302) {
    throw new Error(
      `Real dev login endpoint failed (${accepted.status()}); check local server configuration.`
    );
  }
  await page.waitForURL((url) => !url.pathname.includes("login"), {
    timeout: 30_000,
  });
}
function client(context: BrowserContext) {
  return createTRPCClient<LiveArtifactsRouter>({
    links: [
      (runtime) => {
        const http = httpBatchLink<LiveArtifactsRouter>({
          fetch: async (url, init) => {
            const response = await context.request.fetch(String(url), {
              data: typeof init?.body === "string" ? init.body : undefined,
              headers: Object.fromEntries(new Headers(init?.headers)),
              method: init?.method,
            });
            return new Response(Uint8Array.from(await response.body()).buffer, {
              headers: response.headers(),
              status: response.status(),
            });
          },
          url: `${base}/api/trpc`,
        })(runtime);
        return ({ op, next }) =>
          http({ next, op: { ...op, path: `liveArtifacts.${op.path}` } });
      },
    ],
  });
}
async function panel(page: Page, name: string, mobile: boolean) {
  if (mobile && !(await page.getByRole("dialog").isVisible())) {
    await page
      .getByRole("button", { exact: true, name: "Agent, comments and changes" })
      .click();
  }
  await page.getByRole("button", { exact: true, name }).click();
}
function plainDocument(page: Page) {
  return page.locator(".tiptap").evaluate((node) => {
    const clone = node.cloneNode(true);
    if (!(clone instanceof Element)) {
      return "";
    }
    for (const decoration of clone.querySelectorAll(
      ".collaboration-carets__caret,.live-block-handle"
    )) {
      decoration.remove();
    }
    return clone.textContent ?? "";
  });
}
async function selectParagraph(page: Page) {
  await page
    .locator(".tiptap p")
    .first()
    .evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      node.dispatchEvent(new Event("mouseup", { bubbles: true }));
      document.dispatchEvent(new Event("selectionchange"));
    });
}
try {
  for (const viewport of [
    { height: 800, width: 1280 },
    { height: 844, width: 390 },
  ]) {
    const mobile = viewport.width === 390;
    const pair = await Promise.all([
      browser.newContext({ hasTouch: mobile, isMobile: mobile, viewport }),
      browser.newContext({ hasTouch: mobile, isMobile: mobile, viewport }),
    ]);
    contexts.push(...pair);
    const pages = await Promise.all(pair.map((context) => context.newPage()));
    for (const page of pages) {
      page.setDefaultTimeout(15_000);
      page.on("pageerror", (error) => failures.push(error.message));
    }
    const [alice, bob] = pages;
    if (!(alice && bob && pair[0])) {
      throw new Error("Missing browser pair");
    }
    await login(alice);
    await login(bob);
    const api = client(pair[0]);
    const created = process.env.HM_LIVE_ARTIFACT_ID
      ? { artifactId: process.env.HM_LIVE_ARTIFACT_ID }
      : await api.createDocument.mutate({
          markdown: "# Browser integration\n\nAnchored words stay together.",
          title: `L8 real browser ${viewport.width} ${Date.now()}`,
        });
    const artifactId = z.uuid().parse(created.artifactId);
    await Promise.all(
      pages.map((page) => page.goto(`${base}/a/${artifactId}`))
    );
    for (const page of pages) {
      await expect(
        page.getByRole("region", { name: "Collaborative document editor" })
      ).toBeVisible();
    }
    await expect(alice.locator(".tiptap")).toContainText("Anchored words");
    await expect(bob.locator(".tiptap")).toContainText("Anchored words");
    passed.push(
      `${viewport.width}×${viewport.height}: actual route mounts verified initial room content in two browser profiles`
    );
    await alice.bringToFront();
    await alice.locator(".tiptap p").first().click();
    await alice.keyboard.press("Home");
    await alice.keyboard.type("Alice prefix ");
    await expect.poll(() => plainDocument(bob)).toContain("Alice prefix");
    await bob.bringToFront();
    await bob.locator(".tiptap p").first().click();
    await bob.keyboard.press("End");
    await bob.keyboard.type(" Bob suffix");
    await expect.poll(() => plainDocument(alice)).toContain("Bob suffix");
    await alice.bringToFront();
    await alice.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => plainDocument(bob)).toContain("Bob suffix");
    passed.push(
      `${viewport.width}: real binary room edits converge and own undo preserves peer text`
    );
    await selectParagraph(alice);
    await alice
      .getByRole("button", { exact: true, name: "Comment on selection" })
      .click();
    const comment = `Anchored browser comment ${Date.now()}`;
    await alice
      .getByRole("textbox", { exact: true, name: "Comment" })
      .fill(comment);
    await alice
      .getByRole("button", { exact: true, name: "Post comment" })
      .click();
    await expect(alice.getByText(comment, { exact: true })).toBeVisible();
    await panel(bob, "Comments", mobile);
    await expect(bob.getByText(comment, { exact: true })).toBeVisible();
    passed.push(
      `${viewport.width}: anchored comment persists through real service and appears in peer profile`
    );
    await alice.screenshot({
      fullPage: true,
      path: resolve(evidence, `comments-${viewport.width}.png`),
    });
    const threads = await api.threads.query({ artifactId });
    const thread = threads.items.find((item) =>
      item.comments.some((entry) => entry.body === comment)
    );
    if (thread?.anchor?.kind !== "document" || thread.anchor.detached) {
      throw new Error(
        "New selection comment did not retain a live document anchor"
      );
    }
    await bob
      .getByRole("textbox", { exact: true, name: "Reply" })
      .first()
      .fill("Reply from the second browser profile");
    await bob
      .getByRole("button", { exact: true, name: "Post reply" })
      .first()
      .click();
    await expect(
      alice.getByText("Reply from the second browser profile", { exact: true })
    ).toBeVisible();
    await bob
      .getByRole("button", { exact: true, name: "Resolve thread" })
      .first()
      .click();
    await expect(alice.getByText("Resolved", { exact: true })).toBeVisible();
    passed.push(`${viewport.width}: real reply and resolve propagate`);
    if (mobile) {
      await alice.keyboard.press("Escape");
      await bob.keyboard.press("Escape");
    }
    await alice.bringToFront();
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
      name: "real-room-image.png",
    });
    await expect(alice.locator(".tiptap img")).toBeVisible();
    await expect(bob.locator(".tiptap img")).toBeVisible();
    const imageUrl = await alice.locator(".tiptap img").getAttribute("src");
    const policy = await pair[0].request.get(
      `${base}/api/live-artifacts/${artifactId}/policy`
    );
    const manifest = z
      .object({ ownBlobUrls: z.array(z.string()) })
      .parse(await policy.json());
    expect(manifest.ownBlobUrls).toContain(imageUrl);
    if (!imageUrl) {
      throw new Error("Uploaded image has no URL");
    }
    expect((await pair[1].request.get(new URL(imageUrl, base).href)).ok()).toBe(
      true
    );
    passed.push(
      `${viewport.width}: real persisted image upload, verified ownership policy, room image propagation and peer byte fetch`
    );
    const downloadEvent = alice.waitForEvent("download");
    await alice
      .getByRole("button", { exact: true, name: "Download markdown" })
      .click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toMatch(/\.md$/);
    const exported = await pair[0].request.get(
      `${base}/api/live-artifacts/${artifactId}/markdown`
    );
    const markdown = z
      .object({ filename: z.string(), markdown: z.string() })
      .parse(await exported.json());
    expect(markdown.markdown).toContain("Anchored words stay together.");
    await alice
      .getByRole("button", { exact: true, name: "Version history" })
      .click();
    await alice
      .getByRole("button", { exact: true, name: "Restore Checkpoint v1" })
      .click();
    await alice
      .getByRole("button", { exact: true, name: "Confirm restore" })
      .click();
    await expect
      .poll(() => plainDocument(bob))
      .toContain("Anchored words stay together.");
    await expect.poll(() => plainDocument(bob)).not.toContain("Bob suffix");
    await expect(bob.locator(".tiptap img")).toHaveCount(0);
    passed.push(
      `${viewport.width}: latest persisted Markdown downloads and owner checkpoint restore propagates as a real room edit`
    );
    const before = await api.changes.query({ artifactId });
    if (before.items.some((change) => !change.revertedAt)) {
      await panel(alice, "Agent changes", mobile);
      await alice
        .getByRole("button", { exact: true, name: "Revert" })
        .first()
        .click();
      await alice
        .getByRole("button", { exact: true, name: "Confirm revert" })
        .click();
      await expect
        .poll(
          async () =>
            (await api.changes.query({ artifactId })).items.filter(
              (change) => change.revertedAt
            ).length
        )
        .toBeGreaterThan(
          before.items.filter((change) => change.revertedAt).length
        );
      passed.push(
        `${viewport.width}: actual attributed agent change reverted through service and room`
      );
    } else {
      gates.push(
        `${viewport.width}: no actual agent change exists for revert acceptance; requires an authorized running agent`
      );
    }
    if (await api.session.query({ artifactId })) {
      passed.push(`${viewport.width}: artifact shared session available`);
    } else {
      gates.push(
        `${viewport.width}: no runnable agent/session selected; thread/selection/address-agent run acceptance remains open`
      );
    }
    const overflow = await alice.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    );
    if (overflow) {
      throw new Error("Document exceeds viewport width");
    }
    await alice.screenshot({
      fullPage: true,
      path: resolve(evidence, `document-${viewport.width}.png`),
    });
    for (const context of pair) {
      await context.close();
    }
  }
  gates.push(
    "Two browser profiles currently use the configured dev member; two distinct-member speaker attribution requires a second authorized Clerk identity.",
    "Staging requires externally authenticated deployed environment and is not certified by this local run."
  );
} catch (cause) {
  gates.push(
    cause instanceof Error
      ? (cause.message.split("\n")[0] ?? "Browser acceptance failed")
      : "Browser acceptance failed"
  );
  process.exitCode = 1;
} finally {
  for (const context of contexts) {
    await context.close();
  }
  await browser.close();
}
console.log(
  JSON.stringify({ evidence, gates, pageErrors: failures, passed }, null, 2)
);
