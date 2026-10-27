/** biome-ignore-all lint/performance/noAwaitInLoops: Isolated browser scenarios run sequentially. */
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { expect as browserExpect, chromium } from "@playwright/test";
import { ARTIFACT_VIEW_TOKEN_PREFIX } from "@repo/protocol/artifacts";
import { createLiveArtifactsWithAsk } from "@repo/services/live-artifacts/factory";
import { createSessionsService } from "@repo/services/sessions";
import { SYSTEM_PRINCIPAL } from "@repo/services/workspaces";
import tailwindcss from "@tailwindcss/vite";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { build } from "vite";
import {
  page as pageFiles,
  principals,
} from "../../../../../packages/services/src/artifacts/test-harness";
import { interactionFixture } from "../../../../../packages/services/src/live-artifacts/interaction-fixture";
import { BRIDGE_JS } from "../artifact-content/bridge";
import type { Context } from "../trpc/context";
import { appRouter } from "../trpc/router";
import { mentionEmailAdapter } from "./mention-infra";

const MEMBER_TOKEN = /member:u2/;

test("mounted page/dashboard UI: actual sandbox bridge -> HTTP tRPC -> authorized persisted run; captured mention mail", async () => {
  const h = interactionFixture();
  const documentId = await h.create();
  h.grant(documentId);
  const captures: EmailMessageBuilder[] = [];
  const send = mentionEmailAdapter(
    {
      send: (input: EmailMessage | EmailMessageBuilder) => {
        if (!("subject" in input)) {
          return Promise.reject(new Error("Expected composed mail"));
        }
        captures.push(input);
        return Promise.resolve({ messageId: "captured" });
      },
    },
    "noreply@example.com",
    "https://elements.fixture"
  );
  const service = createLiveArtifactsWithAsk({
    ...h.deps,
    mentions: {
      byEmail: async () => ({
        email: "ann@example.com",
        name: "Ann",
        principal: principals.stranger,
      }),
      recipient: async () => ({
        email: "ann@example.com",
        name: "Ann",
        principal: principals.stranger,
      }),
      send,
    },
  });
  const sessions = createSessionsService(h);
  const ctx = {
    principal: principals.owner,
    services: {
      agents: {
        list: () => Promise.resolve([{ id: "a1", name: "Agent One" }]),
      },
      liveArtifacts: service,
      sessions,
    },
  } as unknown as Context;
  const directory = resolve(
    import.meta.dir,
    "../../components/artifacts/fixtures/element-ask"
  );
  const output = await mkdtemp(join(tmpdir(), "lx3-browser-"));
  const browser = await chromium.launch({ headless: true });
  try {
    await build({
      base: "/",
      build: { emptyOutDir: true, outDir: output },
      configFile: false,
      logLevel: "warn",
      plugins: [tailwindcss()],
      resolve: {
        alias: [
          {
            find: "#/integrations/trpc/client",
            replacement: resolve(import.meta.dir, "fixtures/browser-trpc.ts"),
          },
          { find: "#", replacement: resolve(import.meta.dir, "../..") },
        ],
      },
      root: directory,
    });
    for (const kind of ["page", "dashboard"] as const) {
      const created = await h.deps.artifacts.create(principals.owner, {
        files: pageFiles('<h1 id="sales">Sales total</h1><p>Other element</p>'),
        kind,
        title: "Sales",
      });
      const detail = await h.deps.artifacts.get(
        principals.owner,
        created.artifactId
      );
      const token = `${ARTIFACT_VIEW_TOKEN_PREFIX}${Buffer.from(JSON.stringify({ versionId: detail.currentVersion.id })).toString("base64url")}.fixture`;
      const base = `/a/${created.artifactId}/c/${token}/`;
      const contentUrl = `${base}index.html`;
      const page = await browser.newPage({
        viewport:
          kind === "page"
            ? { height: 900, width: 1280 }
            : { height: 844, width: 390 },
      });
      page.setDefaultTimeout(10_000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname.startsWith("/api/trpc/")) {
          const response = await fetchRequestHandler({
            createContext: () => ctx,
            endpoint: "/api/trpc",
            req: new Request(request.url(), {
              headers: request.headers(),
              method: request.method(),
              ...(request.method() === "POST"
                ? { body: request.postData() }
                : {}),
            }),
            router: appRouter,
          });
          await route.fulfill({
            body: await response.text(),
            headers: Object.fromEntries(response.headers),
            status: response.status,
          });
          return;
        }
        if (url.pathname.startsWith("/api/sessions/")) {
          await route.fulfill({ status: 403 });
          return;
        }
        if (url.pathname === `${base}_hm/bridge.js`) {
          await route.fulfill({
            body: BRIDGE_JS,
            contentType: "application/javascript",
          });
          return;
        }
        if (url.pathname === contentUrl) {
          await route.fulfill({
            body: `<html><head><script src="_hm/bridge.js"></script></head><body><h1 id="sales">Sales total</h1><p>Other element</p></body></html>`,
            contentType: "text/html",
          });
          return;
        }
        try {
          const path = join(
            output,
            url.pathname === "/" ? "index.html" : url.pathname
          );
          await route.fulfill({
            body: await readFile(path),
            contentType:
              {
                ".css": "text/css",
                ".html": "text/html",
                ".js": "application/javascript",
              }[extname(path)] ?? "application/octet-stream",
          });
        } catch {
          await route.fulfill({ status: 404 });
        }
      });
      await page.goto(
        `https://elements.fixture/?${new URLSearchParams({ contentUrl, documentId })}`
      );
      await page
        .getByLabel("Artifact agent", { exact: true })
        .selectOption("a1");
      const frame = page.frameLocator(
        'iframe[title="Sales"], iframe[title="Dashboard"]'
      );
      await frame
        .getByRole("button", { name: "Select element to ask agent" })
        .click();
      await frame.locator("#sales").click();
      await frame
        .getByLabel("Question about selected element")
        .fill("Explain this number");
      await frame
        .getByRole("button", { exact: true, name: "Ask agent" })
        .click();
      await browserExpect(frame.getByRole("status")).toHaveText(
        "Sent to the artifact agent thread"
      );
      const session = await service.session(principals.owner, {
        artifactId: created.artifactId,
      });
      expect(session?.externalKey).toBe(created.artifactId);
      const transcript = await sessions.transcript(
        principals.owner,
        session?.id ?? ""
      );
      expect(JSON.stringify(transcript)).toContain("Explain this number");
      // A changed selected DOM node is rejected before an HTTP/run request.
      await frame
        .getByRole("button", { name: "Select element to ask agent" })
        .click();
      await frame.locator("#sales").click();
      await frame.locator("#sales").evaluate((node) => {
        node.textContent = "Updated";
      });
      await frame
        .getByLabel("Question about selected element")
        .fill("Stale question");
      await frame
        .getByRole("button", { exact: true, name: "Ask agent" })
        .click();
      await browserExpect(frame.getByRole("status")).toHaveText(
        "Element changed. Select it again."
      );
      // Current server authority wins even though the iframe still has a port
      // initialized while the owner was signed in.
      ctx.principal = principals.stranger;
      await frame
        .getByRole("button", { name: "Select element to ask agent" })
        .click();
      await frame.locator("#sales").click();
      await frame
        .getByLabel("Question about selected element")
        .fill("Unauthorized target");
      await frame
        .getByRole("button", { exact: true, name: "Ask agent" })
        .click();
      await browserExpect(frame.getByRole("status")).toHaveText(
        "Artifact or version not found."
      );
      ctx.principal = principals.owner;
      await page
        .getByLabel("Comment", { exact: true })
        .fill("<script>private</script> Please check");
      await page.getByLabel("Mention member by email").fill("ann@example.com");
      await page.getByRole("button", { name: "Add mention" }).click();
      await browserExpect(
        page.getByLabel("Comment", { exact: true })
      ).toHaveValue(MEMBER_TOKEN);
      await page.getByRole("button", { name: "Post comment" }).click();
      await browserExpect(
        page.getByText("Comment posted", { exact: true })
      ).toBeVisible();
      await service.retryMentions(SYSTEM_PRINCIPAL);
      await service.retryMentions(SYSTEM_PRINCIPAL);
      expect(captures).toHaveLength(kind === "page" ? 1 : 2);
      expect(captures.at(-1)?.html).toContain(
        "&lt;script&gt;private&lt;/script&gt;"
      );
      expect(captures.at(-1)?.to).toBe("ann@example.com");
      expect(errors).toEqual([]);
      await page.goto(
        `https://elements.fixture/?${new URLSearchParams({ contentUrl, documentId, preview: "true" })}`
      );
      await frame.locator("body").evaluate(async (node) => {
        const api = Reflect.get(
          node.ownerDocument.defaultView ?? {},
          "harbourmaster"
        );
        await api.ready;
      });
      await browserExpect(
        frame.getByRole("button", { name: "Select element to ask agent" })
      ).toHaveCount(0);
      await page.close();
    }
  } finally {
    await browser.close();
    await rm(output, { force: true, recursive: true });
  }
}, 120_000);
