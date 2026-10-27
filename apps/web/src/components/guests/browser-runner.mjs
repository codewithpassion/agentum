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
  outboundService: () =>
    new Response("External providers disabled in local fixture", {
      status: 503,
    }),
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
      // Hold actual server responses to reproduce navigation before completion.
      for (const phase of ["landing", "send", "verify"]) {
        const first = await create(
          `nav-${phase}-${viewport.width}@example.com`,
          "editor",
          undefined,
          "document"
        );
        const next = await create(
          `next-${phase}-${viewport.width}@example.com`,
          "viewer",
          undefined,
          "document"
        );
        await db
          .prepare(
            "UPDATE artifacts SET title='Previous invitation' WHERE id=?"
          )
          .bind(first.artifactId)
          .run();
        await db
          .prepare("UPDATE artifacts SET title='Current invitation' WHERE id=?")
          .bind(next.artifactId)
          .run();
        const context = await browser.newContext({ viewport });
        const page = await context.newPage();
        let release;
        let arrived;
        const held = new Promise((resolve) => {
          arrived = resolve;
        });
        const gate = new Promise((resolve) => {
          release = resolve;
        });
        let captured = false;
        await page.route("**/*", async (route) => {
          const path = new URL(route.request().url()).pathname;
          if (
            path === "/guest.js" ||
            path === "/guest.css" ||
            path.startsWith("/assets/")
          ) {
            await route.fulfill({
              body: await readFile(join(output, path.slice(1))),
              contentType: path.endsWith(".css")
                ? "text/css"
                : "application/javascript",
            });
            return;
          }
          const target =
            phase === "landing"
              ? `/g/${first.token}`
              : `/api/guest/${first.token}/${phase === "send" ? "code" : "verify"}`;
          if (
            !captured &&
            path === target &&
            (phase !== "landing" ||
              route.request().headers().accept?.includes("application/json"))
          ) {
            captured = true;
            const response = await route.fetch();
            arrived();
            await gate;
            await route.fulfill({ response });
            return;
          }
          await route.continue();
        });
        await page.goto(`${base}/g/${first.token}`);
        if (phase !== "landing") {
          await expect(
            page.getByRole("heading", { name: "Previous invitation" })
          ).toBeVisible();
          await page.getByRole("button", { name: "Send me a code" }).click();
          if (phase === "verify") {
            await expect(page.getByLabel("6-digit code")).toBeVisible();
            const mail = await (await request("/fixture/mail")).json();
            await page
              .getByLabel("6-digit code")
              .fill(mail.at(-1).text.match(/\n(\d{6})\n/)[1]);
            await page.getByRole("button", { name: "Verify code" }).click();
          }
        }
        await held;
        await page.evaluate((path) => {
          history.pushState({}, "", path);
          window.dispatchEvent(new PopStateEvent("popstate"));
        }, `/g/${next.token}`);
        await expect(
          page.getByRole("heading", { name: "Previous invitation" })
        ).toHaveCount(0);
        await expect(page.getByLabel("6-digit code")).toHaveCount(0);
        release();
        await expect(
          page.getByRole("heading", { name: "Current invitation" })
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Send me a code" })
        ).toBeEnabled();
        await expect(page.getByLabel("6-digit code")).toHaveCount(0);
        assert.equal(new URL(page.url()).pathname, `/g/${next.token}`);
        await context.close();
        passed += 1;
      }
      for (const kind of ["document", "deck"]) {
        for (const role of ["editor", "commenter", "viewer"]) {
          const invitation = await create(
            `guest-${kind}-${role}-${viewport.width}@example.com`,
            role,
            undefined,
            kind
          );
          if (role === "editor") {
            await db
              .prepare(
                "INSERT OR IGNORE INTO agents (id,workspace_id,created_by,created_at,instructions,model,name,runtime,runtime_config,slug,status) VALUES ('review-agent','w1','u1',?,'','model','Review agent','machine','{}','review-agent','active')"
              )
              .bind(now)
              .run();
            await db
              .prepare(
                "INSERT INTO sessions (id,workspace_id,agent_id,actor_id,actor_kind,created_at,origin,external_key) VALUES (?,'w1','review-agent','u1','user',?,'artifact',?)"
              )
              .bind(
                `review-session-${invitation.artifactId}`,
                now,
                invitation.artifactId
              )
              .run();
            await db
              .prepare(
                "INSERT INTO runs (id,workspace_id,agent_id,actor_id,actor_kind,created_at,input_text,session_id,status,on_behalf_of_user_id,scope_artifact_id,lease_until) VALUES (?,'w1','review-agent','u1','user',?,'fixture',?,'running','u1',?,?)"
              )
              .bind(
                `review-run-${invitation.artifactId}`,
                now,
                `review-session-${invitation.artifactId}`,
                invitation.artifactId,
                _lease
              )
              .run();
          }
          const other =
            kind === "document" && role === "editor"
              ? await create(
                  `guest-${kind}-${role}-${viewport.width}@example.com`,
                  "viewer",
                  undefined,
                  "document"
                )
              : null;
          const context = await browser.newContext({
            hasTouch: viewport.width === 390,
            isMobile: viewport.width === 390,
            viewport,
          });
          const page = await context.newPage();
          const errors = [];
          const activeRequests = new Map();
          page.on("request", (request) =>
            activeRequests.set(request, {
              action: new URL(request.url()).pathname.split("/").at(-1),
              started: Date.now(),
            })
          );
          page.on("requestfinished", (request) =>
            activeRequests.delete(request)
          );
          page.on("requestfailed", (request) => activeRequests.delete(request));
          page.on("response", (response) => {
            const path = new URL(response.url()).pathname;
            if (path.startsWith("/api/guest/artifacts/") && !response.ok()) {
              console.error(
                "Guest HTTP refusal",
                path.split("/").at(-1),
                response.status()
              );
            }
          });
          page.on("pageerror", (error) => errors.push(error.message));
          await page.route("**/*", async (route) => {
            const path = new URL(route.request().url()).pathname;
            if (
              path === "/guest.js" ||
              path === "/guest.css" ||
              path.startsWith("/assets/")
            ) {
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
          await expect(page.getByLabel("6-digit code")).toBeVisible();
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
            if (role === "editor") {
              await editor.press("ControlOrMeta+End");
              await editor.press("Enter");
              await editor.pressSequentially(`Guest edit ${viewport.width}`);
              await expect(editor).toContainText(
                `Guest edit ${viewport.width}`
              );
              await page.getByLabel("Upload image").setInputFiles({
                buffer: Buffer.from(
                  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4qkAAAAASUVORK5CYII=",
                  "base64"
                ),
                mimeType: "image/png",
                name: "guest.png",
              });
              await expect(editor.locator("img")).toHaveAttribute(
                "src",
                /^blob:/
              );
              await expect
                .poll(() =>
                  editor.locator("img").evaluate((img) => img.naturalWidth)
                )
                .toBe(1);
            } else {
              await expect(editor).toHaveAttribute("contenteditable", "false");
            }
            if (role === "viewer") {
              await expect(page.getByLabel("New comment")).toHaveCount(0);
            } else {
              await page
                .getByLabel("New comment")
                .fill("Browser guest comment");
              const posted = page.waitForResponse((response) =>
                new URL(response.url()).pathname.endsWith("/comment")
              );
              await page.getByRole("button", { name: "Post comment" }).click();
              assert.equal((await posted).status(), 200);
              await expect(
                page
                  .locator(".guest-comments article")
                  .getByText("Browser guest comment", { exact: false })
              ).toBeVisible();
            }
          } else {
            await expect(
              page.getByRole("button", { name: "Version history" })
            ).toHaveCount(0);
            await expect(
              page.getByText("Connecting to the deck room…")
            ).toHaveCount(0);
            await expect(page.getByLabel("Live deck editor")).toBeVisible();
            const frame = page.frameLocator(
              'iframe[title="Sandboxed deck embed"]'
            );
            await expect(
              frame.getByRole("heading", { name: "Guest scoped embed" })
            ).toBeVisible();
            await expect(
              page.locator('iframe[title="Sandboxed deck embed"]')
            ).toHaveAttribute("sandbox", "allow-scripts allow-forms");
            if (role === "viewer") {
              const sourceId = invitation.embedSource.split(":")[1];
              await db
                .prepare("UPDATE artifacts SET audience='private' WHERE id=?")
                .bind(sourceId)
                .run();
              await expect(
                page
                  .getByRole("alert")
                  .filter({ hasText: "Embed source is unavailable" })
              ).toBeVisible({ timeout: 7000 });
              await expect(
                page.locator('iframe[title="Sandboxed deck embed"]')
              ).toHaveCount(0);
            }
          }
          if (other) {
            await page
              .locator(
                `nav[aria-label="Shared with you"] a[href="/g/a/${other.artifactId}"]`
              )
              .click();
            await expect(
              page.getByText("Read only", { exact: true })
            ).toBeVisible();
            await page
              .locator(
                `nav[aria-label="Shared with you"] a[href="/g/a/${invitation.artifactId}"]`
              )
              .click();
            await expect(
              page.getByLabel("Document content", { exact: true })
            ).toContainText(`Guest edit ${viewport.width}`);
          }
          if (role === "editor") {
            const snapshot = async () =>
              (
                await request(`/fixture/accepted/${invitation.artifactId}`)
              ).json();
            // Let the preceding human editor transaction reach authority before
            // comparing the exact accepted revision and CRDT bytes.
            await page.waitForTimeout(200);
            const baseline = await snapshot();
            const propose = async (key) => {
              const response = await post(
                `/fixture/review-proposal/${invitation.artifactId}`,
                { key, kind }
              );
              assert.equal(response.status, 200, await response.clone().text());
              const value = await response.json();
              assert.ok(value.suggestionId);
              return page.getByRole("article", {
                exact: true,
                name: `Suggestion ${value.suggestionId}`,
              });
            };
            const accepted = await propose("accept");
            assert.deepEqual(
              await snapshot(),
              baseline,
              "proposal leaves accepted bytes unchanged"
            );
            await expect(
              accepted.getByText("pending", { exact: true })
            ).toBeVisible({ timeout: 12_000 });
            await accepted.getByText(`Preview ${kind} suggestion`).click();
            await expect(accepted.locator("pre")).toContainText(
              kind === "document" ? "Review accept" : "review-accept"
            );
            const acceptResponse = page.waitForResponse((response) =>
              new URL(response.url()).pathname.endsWith("/decide-suggestion")
            );
            await accepted
              .getByRole("button", { exact: true, name: "Accept suggestion" })
              .click();
            assert.equal((await acceptResponse).status(), 200);
            await expect(
              accepted.getByText("accepted", { exact: true })
            ).toBeVisible();
            const acceptedBytes = await snapshot();
            assert.notDeepEqual(acceptedBytes, baseline);
            const rejected = await propose("reject");
            assert.deepEqual(await snapshot(), acceptedBytes);
            await expect(
              rejected.getByRole("button", {
                exact: true,
                name: "Reject suggestion",
              })
            ).toBeVisible({ timeout: 12_000 });
            await rejected
              .getByRole("button", { exact: true, name: "Reject suggestion" })
              .click();
            await expect(
              rejected.getByText("rejected", { exact: true })
            ).toBeVisible();
            assert.deepEqual(
              await snapshot(),
              acceptedBytes,
              "rejection leaves accepted bytes unchanged"
            );
            await page.reload();
            await expect(
              accepted.getByText("accepted", { exact: true })
            ).toBeVisible();
            await expect(
              rejected.getByText("rejected", { exact: true })
            ).toBeVisible();
            const stale = await propose("downgrade");
            await expect(
              stale.getByRole("button", {
                exact: true,
                name: "Accept suggestion",
              })
            ).toBeVisible({ timeout: 12_000 });
            let arrived, release;
            const held = new Promise((resolve) => {
              arrived = resolve;
            });
            const gate = new Promise((resolve) => {
              release = resolve;
            });
            const hold = async (route) => {
              arrived();
              await gate;
              await route.continue();
            };
            await page.route("**/decide-suggestion", hold);
            const denied = page.waitForResponse((response) =>
              new URL(response.url()).pathname.endsWith("/decide-suggestion")
            );
            await stale
              .getByRole("button", { exact: true, name: "Accept suggestion" })
              .click();
            await held;
            await post(
              `/fixture/role/${invitation.artifactId}/${invitation.memberId}`,
              {}
            );
            release();
            assert.equal(
              (await denied).status(),
              404,
              "decision rechecks current downgraded role"
            );
            await page.unroute("**/decide-suggestion", hold);
            assert.deepEqual(await snapshot(), acceptedBytes);
            // Let the failure handler's queued credential verification consume
            // its rotated response before navigating away from the host lock.
            await page.waitForLoadState("networkidle").catch(async (cause) => {
              console.error("Decision reload diagnostics", {
                active: [...activeRequests.values()].map((entry) => ({
                  ...entry,
                  elapsed: Date.now() - entry.started,
                })),
                kind,
                locks: await page.evaluate(() => navigator.locks.query()),
                role,
                viewport,
              });
              throw cause;
            });
            await page.reload();
            await expect(
              stale.getByText("pending", { exact: true })
            ).toBeVisible();
            await expect(
              page.getByRole("button", {
                exact: true,
                name: "Accept suggestion",
              })
            ).toHaveCount(0);
            await expect(
              page.getByRole("button", {
                exact: true,
                name: "Reject suggestion",
              })
            ).toHaveCount(0);
            assert.deepEqual(await snapshot(), acceptedBytes);
            assert.deepEqual(errors, []);
            await post(
              `/fixture/revoke/${invitation.artifactId}/${invitation.memberId}`,
              {}
            );
            await expect(
              page.getByRole("heading", { name: "This invite has ended" })
            ).toBeVisible({ timeout: 7000 });
            await context.close();
            passed += 12;
            continue;
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
    }
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify({ passed }));
} finally {
  await runtime.dispose();
  await rm(directory, { force: true, recursive: true });
}
