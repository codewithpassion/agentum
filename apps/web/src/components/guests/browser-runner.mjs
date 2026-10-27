// biome-ignore-all lint/performance/noNamespaceImport: Yjs/lib0 protocol namespaces in standalone fixture.
// biome-ignore-all lint/style/useDestructuring: sequential integration assertions retain named intermediate values.
// biome-ignore-all lint/performance/useTopLevelRegex: fixture-only credential extraction.
// biome-ignore-all lint/suspicious/noShadow: isolated callback arguments in the ordered fixture.
// biome-ignore-all lint/performance/noAwaitInLoops: ordered integration scenario and migrations.
// biome-ignore-all lint/suspicious/noMisplacedAssertion: standalone workerd integration runner.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
}
const { script, output } = JSON.parse(input);
const directory = await mkdtemp(join(tmpdir(), "live-production-"));
const options = {
  bindings: {
    ALLOWED_ORG_IDS: "org_w1",
    ARTIFACT_LINKS_OFF: "",
    ARTIFACT_VIEW_KEY: "production-integration-private-test-key",
    CLERK_SECRET_KEY: "sk_test_fixture",
    MAIL_DOMAIN: "",
    PUBLIC_BASE_URL: "http://localhost",
    RUN_TOKEN_KEY: Buffer.alloc(32, 7).toString("base64"),
    SECRETS_KEY: Buffer.alloc(32, 8).toString("base64"),
  },
  compatibilityDate: "2026-08-19",
  compatibilityFlags: ["nodejs_compat"],
  d1Databases: ["DB"],
  durableObjects: {
    ARTIFACT_ROOM: { className: "ArtifactRoom", useSQLite: true },
    LIVE_ARTIFACT_MAINTENANCE: {
      className: "LiveArtifactMaintenance",
      useSQLite: true,
    },
    SESSION_STREAM: { className: "SessionStream" },
  },
  modules: true,
  r2Buckets: ["FILES"],
  resourcePersistencePath: directory,
  script,
};
const runtime = new Miniflare(convertV4MiniflareOptions(options));
let passed = 0;
try {
  const db = await runtime.getD1Database("DB");
  const migrations = resolve(
    import.meta.dirname,
    "../../../../../packages/db/migrations"
  );
  for (const name of (await readdir(migrations))
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    const sql = await readFile(join(migrations, name), "utf8");
    const statements = sql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
    await db.batch(statements.map((s) => db.prepare(s)));
  }
  const now = new Date().toISOString(),
    _lease = new Date(Date.now() + 3_600_000).toISOString();
  await db
    .prepare(
      "INSERT INTO workspaces (id,clerk_org_id,name,timezone,created_at) VALUES ('w1','org_w1','Guest fixture','UTC',?)"
    )
    .bind(now)
    .run();
  const request = (path, init = {}) =>
    runtime.dispatchFetch(`http://localhost${path}`, init);
  const post = async (path, body, cookie) => {
    const response = await request(path, {
      body: JSON.stringify(body),
      headers: {
        "CF-Connecting-IP": "192.0.2.1",
        "Content-Type": "application/json",
        Origin: "http://localhost",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      method: "POST",
    });
    return response;
  };
  const create = async (email, role, artifactId, kind) => {
    const response = await post("/fixture/create", {
      artifactId,
      email,
      kind,
      role,
    });
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    const text = result.mail.at(-1).text;
    return { ...result, token: text.match(/hm_invite_[A-Za-z0-9_-]+/)[0] };
  };
  const browser = await chromium.launch({ headless: true });
  const base = new URL(await runtime.ready).origin.replace(
    "127.0.0.1",
    "localhost"
  );
  try {
    for (const viewport of [
      { height: 800, width: 1280 },
      { height: 844, width: 390 },
    ]) {
      for (const kind of ["document", "deck"]) {
        const invitation = await create(
          `guest-${kind}-${viewport.width}@example.com`,
          "editor",
          undefined,
          kind
        );
        const context = await browser.newContext({
          hasTouch: viewport.width === 390,
          isMobile: viewport.width === 390,
          viewport,
        });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.route("**/*", async (route) => {
          const path = new URL(route.request().url()).pathname;
          if (path === "/guest.js" || path.startsWith("/assets/")) {
            const file = join(output, path.slice(1));
            await route.fulfill({
              body: await readFile(file),
              contentType: path.endsWith(".css")
                ? "text/css"
                : "application/javascript",
            });
          } else {
            await route.continue();
          }
        });
        await page.goto(`${base}/g/${invitation.token}`);
        await expect(
          page.getByRole("button", { name: "Send me a code" })
        ).toBeVisible();
        const before = await db
          .prepare("SELECT count(*) n FROM guest_codes")
          .first();
        await page.reload();
        await expect(
          page.getByRole("button", { name: "Send me a code" })
        ).toBeVisible();
        assert.equal(
          (await db.prepare("SELECT count(*) n FROM guest_codes").first()).n,
          before.n
        );
        await page.getByRole("button", { name: "Send me a code" }).click();
        const mail = await (await request("/fixture/mail")).json();
        const code = mail.at(-1).text.match(/\n(\d{6})\n/)[1];
        await page.getByLabel("6-digit code").fill(code);
        await page.getByRole("button", { name: "Verify code" }).click();
        await expect(
          page.getByText("Your visits are logged.", { exact: false })
        ).toBeVisible();
        if (kind === "document") {
          const editor = page.getByLabel("Document content", { exact: true });
          await expect(editor).toBeVisible();
          await editor.press("ControlOrMeta+End");
          await editor.press("Enter");
          await editor.pressSequentially(`Guest edit ${viewport.width}`);
          await expect(editor).toContainText(`Guest edit ${viewport.width}`);
          await page.getByLabel("New comment").fill("Browser guest comment");
          await page.getByRole("button", { name: "Post comment" }).click();
          await expect(
            page.getByText("Browser guest comment", { exact: false })
          ).toBeVisible();
        } else {
          await expect(
            page.getByRole("button", { name: "Version history" })
          ).toHaveCount(0);
          await expect(
            page.getByText("Connecting to the deck room…")
          ).toHaveCount(0);
          await expect(page.getByLabel("Live deck editor")).toBeVisible();
        }
        assert.deepEqual(errors, []);
        await page
          .getByRole("button", { exact: true, name: "Sign out" })
          .click();
        await expect(
          page.getByRole("heading", { name: "Signed out" })
        ).toBeVisible();
        await context.close();
        passed += 1;
      }
    }
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify({ passed }));
} finally {
  await runtime.dispose();
  await rm(directory, { force: true, recursive: true });
}
