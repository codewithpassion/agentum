// biome-ignore-all lint/style/useDestructuring: sequential scenario keeps named intermediate objects.
// biome-ignore-all lint/suspicious/noShadow: local ordered fixture scopes.
// biome-ignore-all lint/suspicious/noMisplacedAssertion: standalone workerd executable test.
// biome-ignore-all lint/performance/noAwaitInLoops: ordered durable recovery fixture.
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
const directory = await mkdtemp(join(tmpdir(), "guest-execution-"));
const options = {
  bindings: {
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
    GUEST_RUN: { className: "GuestRun", useSQLite: true },
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
let checks = 0;
const check = (value, message) => {
  assert.ok(value, message);
  checks += 1;
};
try {
  const db = await runtime.getD1Database("DB");
  for (const name of (
    await readdir(
      resolve(import.meta.dirname, "../../../../../packages/db/migrations")
    )
  )
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    const sql = await readFile(
      resolve(
        import.meta.dirname,
        "../../../../../packages/db/migrations",
        name
      ),
      "utf8"
    );
    await db.batch(
      sql
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => db.prepare(s))
    );
  }
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO workspaces(id,clerk_org_id,name,timezone,created_at) VALUES('w1','org_w1','Guest runtime','UTC',?)"
    )
    .bind(now)
    .run();
  await db
    .prepare(
      "INSERT INTO agents(id,workspace_id,created_by,created_at,instructions,model,name,runtime,runtime_config,slug,status) VALUES('a1','w1','u1',?,'PRIVATE MUST NEVER REACH GUEST','openrouter:z-ai/glm-5.3','Agent','cloud','{}','agent','active')"
    )
    .bind(now)
    .run();
  const request = (path, init = {}) =>
    runtime.dispatchFetch(`http://localhost${path}`, init);
  const post = async (path, body = {}) => {
    const response = await request(path, {
      body: JSON.stringify(body),
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost",
      },
      method: "POST",
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
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
        const invitation = await post("/fixture/create", {
          email: `${kind}-${viewport.width}@example.com`,
          kind,
        });
        const id = invitation.artifactId;
        await db
          .prepare("UPDATE artifacts SET agent_id='a1' WHERE id=?")
          .bind(id)
          .run();
        const token = invitation.mail
          .at(-1)
          .text.match(/hm_invite_[A-Za-z0-9_-]+/)[0];
        const context = await browser.newContext({ viewport });
        const page = await context.newPage();
        // Drain the current handshake AND prevent queued work from starting
        // between requesting navigation and destruction of the old document.
        // Chromium releases this lock when it destroys that document.
        const navigate = (target) =>
          Promise.all([
            page.waitForNavigation({ waitUntil: "domcontentloaded" }),
            page.evaluate((destination) => {
              navigator.locks.request("harbourmaster-guest-cookie", () => {
                if (destination) {
                  location.assign(destination);
                } else {
                  location.reload();
                }
                return new Promise(() => {
                  /* Released by document destruction. */
                });
              });
            }, target),
          ]);
        const reload = () => navigate();
        const errors = [];
        page.on("pageerror", (error) => {
          errors.push(error.message);
          console.error(error.message);
        });
        let streamCount = 0;
        page.on("response", (response) => {
          if (response.url().includes("/session/stream") && response.ok()) {
            streamCount += 1;
          }
        });
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
          } else {
            await route.continue();
          }
        });
        await page.goto(`${base}/g/${token}`);
        await page.getByRole("button", { name: "Send me a code" }).click();
        await expect(page.getByLabel("6-digit code")).toBeVisible();
        const mail = await (await request("/fixture/mail")).json();
        await page
          .getByLabel("6-digit code")
          .fill(mail.at(-1).text.match(/\b\d{6}\b/)[0]);
        await page.getByRole("button", { name: "Verify code" }).click();
        const composer = page.getByRole("region", {
          exact: true,
          name: "Ask agent",
        });
        const thread = page.getByRole("region", {
          name: "Shared agent transcript",
        });
        await expect(
          composer.getByRole("button", { name: "Send request" })
        ).toBeDisabled();
        await expect(composer.getByLabel("Message to agent")).toBeEnabled();
        for (const configuredRuntime of ["machine", "managed"]) {
          await db
            .prepare("UPDATE agents SET runtime=? WHERE id='a1'")
            .bind(configuredRuntime)
            .run();
          const ready = await page.evaluate(
            (artifactId) =>
              navigator.locks.request("harbourmaster-guest-cookie", async () =>
                (
                  await fetch(
                    `/api/guest/artifacts/${artifactId}/ask-availability`
                  )
                ).json()
              ),
            id
          );
          assert.equal(
            ready.available,
            true,
            "configured runtime uses dedicated restricted inference"
          );
        }
        await db
          .prepare(
            "UPDATE agents SET runtime='cloud', model='unsupported-model' WHERE id='a1'"
          )
          .run();
        // Query through the browser queue after the policy changes, never mock readiness.
        const unavailable = await page.evaluate(
          (artifactId) =>
            navigator.locks.request("harbourmaster-guest-cookie", async () =>
              (
                await fetch(
                  `/api/guest/artifacts/${artifactId}/ask-availability`
                )
              ).json()
            ),
          id
        );
        assert.equal(unavailable.available, false);
        await db
          .prepare(
            "UPDATE agents SET model='openrouter:z-ai/glm-5.3' WHERE id='a1'"
          )
          .run();
        await expect(composer.getByLabel("Message to agent")).toBeEnabled({
          timeout: 10_000,
        });
        checks += 3;
        if (kind === "document") {
          const editor = page.getByLabel("Document content", { exact: true });
          await editor.locator("h1").click();
          await page.keyboard.press("Home");
          await page.keyboard.press("Shift+End");
          await expect(
            page.getByRole("button", { exact: true, name: "Ask agent" })
          ).toBeVisible();
          await page
            .getByRole("button", { exact: true, name: "Ask agent" })
            .click();
          await expect(composer.getByText(/Room context:/)).toContainText(
            "Accepted original"
          );
          checks += 1;
        } else {
          await expect(page.getByLabel("Live deck editor")).toBeVisible();
          await page
            .getByRole("button", { name: "Ask about selection" })
            .click();
          await expect(composer.getByText(/Room context:/)).toContainText(
            "slide 1"
          );
          checks += 1;
        }
        await composer.getByLabel("Message to agent").fill("suggest a change");
        let firstBody;
        let firstResult;
        const loseReply = async (route) => {
          firstBody = route.request().postDataJSON();
          const response = await route.fetch();
          firstResult = await response.json();
          // Preserve real rotated Set-Cookie but make the JSON unreadable: ambiguous acknowledgement.
          await route.fulfill({ body: "unreadable acknowledgement", response });
        };
        await page.route("**/ask", loseReply);
        await composer.getByRole("button", { name: "Send request" }).click();
        await expect(
          composer.getByRole("button", { name: "Retry request" })
        ).toBeEnabled();
        await page.unroute("**/ask", loseReply);
        check(
          Object.keys(firstBody).sort().join(",") === "agentId,requestId,text",
          "strict actual composer payload"
        );
        await reload();
        await expect(
          composer.getByRole("button", { name: "Retry request" })
        ).toBeEnabled();
        const retried = page.waitForResponse((response) =>
          response.url().endsWith("/ask")
        );
        await composer.getByRole("button", { name: "Retry request" }).click();
        const retryResponse = await retried;
        assert.deepEqual(retryResponse.request().postDataJSON(), firstBody);
        assert.equal((await retryResponse.json()).runId, firstResult.runId);
        checks += 2;
        const runId = firstResult.runId;
        for (let i = 0; i < 4; i += 1) {
          await post(`/fixture/advance/${runId}`);
        }
        await expect(
          thread
            .getByText("Waiting for a workspace member to answer in Needs you.")
            .first()
        ).toBeVisible();
        await expect(thread.getByRole("button")).toHaveCount(0);
        const before = await (await request(`/fixture/snapshot/${id}`)).json();
        const requests = await (await request("/fixture/requests")).json();
        const held =
          requests.find((entry) => entry.runId === runId) ?? requests.at(-1);
        assert.ok(held);
        let releasePoll;
        let pollHeld;
        const heldPoll = new Promise((resolve) => {
          pollHeld = resolve;
        });
        const pollBarrier = new Promise((resolve) => {
          releasePoll = resolve;
        });
        const holdPoll = async (route) => {
          const response = await route.fetch();
          pollHeld();
          await pollBarrier;
          await route.fulfill({ response });
        };
        const sessionPattern = /\/session(?:\?.*)?$/;
        await page.route(sessionPattern, holdPoll);
        await heldPoll;
        await post(`/fixture/answer/${held.id}`);
        for (let i = 0; i < 7; i += 1) {
          await post(`/fixture/advance/${runId}`);
        }
        await expect(
          thread.getByText("Captured guest completion")
        ).toBeVisible();
        await expect(
          thread.getByText("done", { exact: true }).first()
        ).toBeVisible();
        releasePoll();
        await page.unroute(sessionPattern, holdPoll);
        checks += 1;
        const suggestions = page.getByRole("region", {
          name: "Agent suggestions",
        });
        await expect(
          suggestions.getByText("pending", { exact: true })
        ).toBeVisible();
        assert.deepEqual(
          await (await request(`/fixture/snapshot/${id}`)).json(),
          before
        );
        check(streamCount > 0, "actual mounted guest SSE subscription");
        const row = await db
          .prepare("SELECT * FROM runs WHERE id=?")
          .bind(runId)
          .first();
        check(
          row.status === "done" &&
            row.actor_kind === "guest" &&
            row.on_behalf_of_user_id === null &&
            row.scope_artifact_id === id,
          "real GuestRun completion provenance"
        );
        const r2 = await runtime.getR2Bucket("FILES");
        const capture = await (
          await r2.get(`fixture-inference/${runId}/0`)
        ).json();
        check(
          JSON.parse(capture.text).harbourmaster_turn.from.kind === "guest" &&
            !capture.text.includes("PRIVATE MUST"),
          "server speaker envelope and isolated model capture"
        );
        if (kind === "document") {
          check(
            capture.text.includes("Accepted original"),
            "trusted room selection reached model"
          );
        }
        await reload();
        await expect(
          thread.getByText("Captured guest completion")
        ).toBeVisible();
        await expect(
          suggestions.getByText("pending", { exact: true })
        ).toBeVisible();
        check(
          (await thread.locator("strong").allTextContents()).some(
            (name) => name !== "user" && name !== "assistant"
          ),
          "shared transcript server-resolved author"
        );
        const heldAsk = async (route) => {
          await post(`/fixture/role/${id}/${invitation.memberId}`);
          await route.continue();
        };
        await composer
          .getByLabel("Message to agent")
          .fill("current downgrade must refuse");
        await page.route("**/ask", heldAsk);
        const refused = page.waitForResponse((response) =>
          response.url().endsWith("/ask")
        );
        await composer.getByRole("button", { name: "Send request" }).click();
        assert.equal((await refused).status(), 404);
        // Existing room downgrade fencing unmounts editors and asks for a fresh
        // authoritative snapshot. The in-flight ask still refuses at HTTP.
        await page
          .getByRole("button", { exact: true, name: "Reconnect" })
          .click();
        await expect(composer.getByLabel("Message to agent")).toBeDisabled();
        await expect(
          composer.getByRole("button", { name: "Retry request" })
        ).toBeDisabled();
        const count = await db
          .prepare("SELECT count(*) AS n FROM runs WHERE scope_artifact_id=?")
          .bind(id)
          .first();
        assert.equal(count.n, 1);
        assert.deepEqual(
          await (await request(`/fixture/snapshot/${id}`)).json(),
          before
        );
        check(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth
          ),
          "desktop/phone horizontal fit"
        );
        // Leave an ambiguous draft on A, sign out from B, then authenticate
        // another real guest to A in this same tab/storage partition.
        const otherArtifact = await post("/fixture/create", {
          email: `${kind}-${viewport.width}@example.com`,
          kind,
        });
        await db
          .prepare("UPDATE artifacts SET agent_id='a1' WHERE id=?")
          .bind(otherArtifact.artifactId)
          .run();
        await navigate(`${base}/g/a/${otherArtifact.artifactId}`);
        await expect(composer.getByLabel("Message to agent")).toBeEnabled();
        await page
          .getByRole("button", { exact: true, name: "Sign out" })
          .click();
        await expect(
          page.getByText("Signed out", { exact: true })
        ).toBeVisible();
        check(
          await page.evaluate(() =>
            Object.keys(sessionStorage).every(
              (key) => !key.startsWith("harbourmaster:guest-ask:")
            )
          ),
          "signout on B clears pending asks from A"
        );
        const nextGuest = await post("/fixture/create", {
          artifactId: id,
          email: `next-${kind}-${viewport.width}@example.com`,
          role: "commenter",
        });
        const nextToken = nextGuest.mail
          .at(-1)
          .text.match(/hm_invite_[A-Za-z0-9_-]+/)[0];
        await page.goto(`${base}/g/${nextToken}`);
        await page.getByRole("button", { name: "Send me a code" }).click();
        await expect(page.getByLabel("6-digit code")).toBeVisible();
        const nextMail = await (await request("/fixture/mail")).json();
        await page
          .getByLabel("6-digit code")
          .fill(nextMail.at(-1).text.match(/\b\d{6}\b/)[0]);
        await page.getByRole("button", { name: "Verify code" }).click();
        await expect(composer.getByLabel("Message to agent")).toBeEnabled();
        await expect(composer.getByLabel("Message to agent")).toHaveValue("");
        await expect(
          composer.getByRole("button", { name: "Retry request" })
        ).toHaveCount(0);
        checks += 3;
        await db
          .prepare("UPDATE agents SET runtime=?,model='sonnet' WHERE id='a1'")
          .bind(viewport.width === 1280 ? "machine" : "managed")
          .run();
        const comments = page.getByRole("region", {
          exact: true,
          name: "Comments",
        });
        await comments.getByLabel("Address to agent").check();
        await comments
          .getByLabel("New comment", { exact: true })
          .fill("Please answer this browser addressed comment");
        const posted = page.waitForResponse(
          (response) =>
            response.url().endsWith(`/api/guest/artifacts/${id}/comment`) &&
            response.request().method() === "POST"
        );
        await comments
          .getByRole("button", { exact: true, name: "Post comment" })
          .click();
        const addressedResponse = await posted;
        assert.equal(
          addressedResponse.status(),
          200,
          await addressedResponse.text()
        );
        const addressed = await addressedResponse.json();
        const sentComment = addressedResponse.request().postDataJSON();
        assert.ok(
          sentComment.toAgent && sentComment.requestId,
          "UI uses explicit addressed trigger with stable request id"
        );
        for (let i = 0; i < 4; i += 1) {
          await post(`/fixture/advance/${addressed.runId}`, {});
        }
        const waiting = await (await request("/fixture/requests")).json();
        assert.equal(waiting.length, 1);
        await post(`/fixture/answer/${waiting[0].id}`, {});
        for (let i = 0; i < 7; i += 1) {
          await post(`/fixture/advance/${addressed.runId}`, {});
        }
        await expect(
          comments.getByText("Scoped commenter reply", { exact: false })
        ).toBeVisible({ timeout: 10_000 });
        await expect(
          comments.getByText("Captured guest completion", { exact: false })
        ).toBeVisible();
        const original = await db
          .prepare("SELECT * FROM artifact_comment_threads WHERE id=?")
          .bind(addressed.threadId)
          .first();
        assert.ok(
          original.answered_at && original.resolved_at === null,
          "browser agent answers original human thread without resolving"
        );
        const guestRun = await db
          .prepare("SELECT * FROM runs WHERE id=?")
          .bind(addressed.runId)
          .first();
        assert.equal(guestRun.status, "done");
        assert.equal(guestRun.actor_kind, "guest");
        assert.equal(guestRun.scope_artifact_id, id);
        await reload();
        await expect(
          comments.getByText("Scoped commenter reply", { exact: false })
        ).toBeVisible();
        await expect(
          comments.getByText("Captured guest completion", { exact: false })
        ).toBeVisible();
        checks += 9;
        assert.deepEqual(errors, []);
        checks += 8;
        if (kind === "document" && viewport.width === 1280) {
          // Bounded causal experiment, on the disposable authenticated context.
          // A static document removes polling/timer timing from this experiment.
          // Only statuses/counts/phase names are recorded, never credentials.
          const probeUrl = `${base}/g/a/${id}?reload-probe=1`;
          let gate;
          await page.route(probeUrl, async (route) => {
            await gate;
            await route.fulfill({
              body: "<!doctype html><title>Reload lifecycle probe</title>",
              contentType: "text/html",
            });
          });
          await navigate(probeUrl);
          for (const retainLock of [true, false]) {
            let rotated;
            const rotation = new Promise((resolve) => {
              rotated = resolve;
            });
            let attempts = 0;
            const pattern = "**/ask-availability?reload-probe=1";
            let finish;
            const committed = new Promise((resolve) => {
              finish = resolve;
            });
            const delayed = async (route) => {
              attempts += 1;
              // Dispatch the real route without Playwright's APIRequestContext:
              // route.fetch() would install Set-Cookie before browser delivery.
              const response = await request(
                new URL(route.request().url()).pathname,
                { headers: await route.request().allHeaders() }
              );
              assert.equal(response.status, 200);
              assert.ok(response.headers.has("Set-Cookie"));
              await response.body?.cancel();
              rotated();
              // Deliver no response headers until navigation has destroyed the
              // old document, matching an interrupted delayed HTTP handshake.
              await committed;
              await route.abort().catch(() => {
                /* Navigation may already cancel the route. */
              });
            };
            await page.route(pattern, delayed);
            // For the old helper, hold only document commit until the queued
            // request has rotated. Fixed helper must never admit that request.
            gate = retainLock ? undefined : rotation;
            const navigation = page.waitForNavigation({
              waitUntil: "domcontentloaded",
            });
            await page.evaluate(
              ({ artifactId, hold }) => {
                navigator.locks.request("harbourmaster-guest-cookie", () => {
                  location.reload();
                  if (hold) {
                    return new Promise(() => {
                      /* Released by document destruction. */
                    });
                  }
                });
                navigator.locks
                  .request("harbourmaster-guest-cookie", async () => {
                    await fetch(
                      `/api/guest/artifacts/${artifactId}/ask-availability?reload-probe=1`
                    );
                  })
                  .catch(() => {
                    /* Old document is being destroyed. */
                  });
              },
              { artifactId: id, hold: retainLock }
            );
            try {
              await navigation;
            } finally {
              finish();
              // Unblock intercepted navigation too if its bounded wait fails.
              rotated();
            }
            gate = undefined;
            await page.unroute(pattern, delayed, { behavior: "wait" });
            assert.equal(attempts, retainLock ? 0 : 1);
            const status = await page.evaluate(async (artifactId) => {
              const response = await fetch(
                `/api/guest/artifacts/${artifactId}/open`
              );
              await response.text();
              return response.status;
            }, id);
            // The original helper commits a rotation whose response never
            // reaches the browser. The previous token recovers it once, so the
            // session survives either way (LR.1).
            assert.equal(status, 200);
            checks += 2;
            console.log(
              JSON.stringify({
                openStatus: status,
                queuedRequests: attempts,
                reloadProbe: retainLock ? "retained-lock" : "original-helper",
              })
            );
          }
          await page.unroute(probeUrl);
          await navigate(`${base}/g/a/${id}`);
          await expect(composer).toBeVisible();
          await expect(
            page.getByText("This invite has ended", { exact: true })
          ).toHaveCount(0);
          checks += 1;
        }
        await context.close();
      }
    }
    process.stdout.write(
      `${JSON.stringify({ checks, matrix: "document/deck desktop/phone real GuestRun" })}\n`
    );
  } finally {
    await browser.close();
  }
} finally {
  await runtime.dispose();
  await rm(directory, { force: true, recursive: true });
}
