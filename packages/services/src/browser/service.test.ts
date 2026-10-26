import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { agents, browserSessions } from "@repo/db/schema/agents";
import { events as eventRows } from "@repo/db/schema/events";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { workspaces } from "@repo/db/schema/workspaces";
import { taskFolderPath } from "@repo/db/shared";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { ForbiddenError } from "../authz.ts";
import { ServiceError } from "../errors.ts";
import { createEventsService } from "../events.ts";
import { memoryLibraryBlobs } from "../library/memory.ts";
import { createLibraryService } from "../library.ts";
import type { Principal } from "../workspaces.ts";
import { type BrowserDriver, type BrowserPage, createBrowserService, KEEP_ALIVE_MS } from "./index.ts";

const START = "2026-10-27T00:00:00.000Z";
const principal = { agentId: "a", kind: "run", runId: "r", workspaceId: "w" } as const;
const png = new Uint8Array([137, 80, 78, 71]);
class FakeDriver implements BrowserDriver {
  launches = 0;
  connections: string[] = [];
  stale = false;
  fail = false;
  released = 0;
  url = "about:blank";
  page: BrowserPage = {
    click: () => this.action(),
    fill: () => this.action(),
    navigate: (url) => { this.url = url; return this.action(); },
    release: () => { this.released += 1; return Promise.resolve(); },
    screenshot: () => Promise.resolve(png),
    snapshot: () => Promise.resolve({ links: [], text: "secret page text", title: "Private title", url: this.url }),
  };
  action() { return this.fail ? Promise.reject(new Error("secret failure")) : Promise.resolve(); }
  launch(options: { keepAliveMs: number }) {
    expect(options.keepAliveMs).toBe(KEEP_ALIVE_MS);
    this.launches += 1;
    return Promise.resolve({ page: this.page, sessionId: `session-${this.launches}` });
  }
  connect(id: string) {
    this.connections.push(id);
    return this.stale ? Promise.reject(new Error("gone")) : Promise.resolve(this.page);
  }
}
let db: ReturnType<typeof migrated>;
let driver: FakeDriver;
let service: ReturnType<typeof createBrowserService>;
let library: ReturnType<typeof createLibraryService>;
let now: number;
beforeEach(() => {
  db = migrated();
  now = Date.parse(START);
  driver = new FakeDriver();
  const clock = { now: () => new Date(now) };
  const atomic = sqliteAtomic(db);
  const events = createEventsService({ db, blobs: { get: () => Promise.resolve(null), put: () => Promise.resolve() } });
  library = createLibraryService({ db, atomic, clock: { ...clock, sleep: () => Promise.resolve() }, events, blobs: memoryLibraryBlobs() });
  service = createBrowserService({ db, atomic, clock, driver, events, library });
  db.insert(workspaces).values({ id: "w", clerkOrgId: "org", createdAt: START, name: "W", timezone: "UTC" }).run();
  db.insert(agents).values({ id: "a", workspaceId: "w", slug: "agent", name: "Agent", model: "m", runtime: "fake", runtimeConfig: "{}", instructions: "", createdBy: "u", createdAt: START, status: "active" }).run();
  db.insert(sessions).values({ id: "s", workspaceId: "w", agentId: "a", actorId: "u", actorKind: "user", origin: "ui", createdAt: START }).run();
  db.insert(runs).values({ id: "r", workspaceId: "w", agentId: "a", sessionId: "s", actorId: "u", actorKind: "user", status: "running", inputText: "", createdAt: START }).run();
});
test("persists a session and reconnects through a fresh service instance", async () => {
  await service.navigate(principal, "https://example.com/private?q=secret");
  await service.snapshot(principal);
  expect(driver.launches).toBe(1);
  expect(driver.connections).toEqual(["session-1"]);
  expect(db.select().from(browserSessions).all()[0]).toMatchObject({ agentId: "a", sessionId: "session-1", currentUrl: driver.url, updatedAt: START });
  expect(driver.released).toBe(2);
});
test("relaunches after rejected reconnect and after the idle deadline", async () => {
  await service.snapshot(principal);
  driver.stale = true;
  await service.snapshot(principal);
  expect(driver.launches).toBe(2);
  driver.stale = false;
  now += KEEP_ALIVE_MS;
  await service.snapshot(principal);
  expect(driver.launches).toBe(3);
  expect(driver.connections).toEqual(["session-1"]);
});
test("screenshots are library files in the run task folder with missing folders created", async () => {
  const entry = await service.screenshot(principal);
  expect(entry.path.startsWith(`${taskFolderPath("agent", "r")}/`)).toBe(true);
  expect(entry.path.endsWith(".png")).toBe(true);
  expect((await library.read(principal, entry.path)).bytes).toEqual(png);
});
test("events contain action, host and outcome only, including validation and driver failures", async () => {
  await service.navigate(principal, "https://example.com/private?q=secret");
  await service.fill(principal, "#password", "secret password");
  driver.fail = true;
  await expect(service.click(principal, "#secret")).rejects.toBeInstanceOf(ServiceError);
  await expect(service.navigate(principal, "http://127.0.0.1")).rejects.toBeInstanceOf(ServiceError);
  const rows = db.select().from(eventRows).where(eq(eventRows.type, "browser.action")).all();
  expect(rows.map(row => JSON.parse(row.payload ?? "{}"))).toEqual([
    { action: "navigate", host: "example.com", outcome: "success" },
    { action: "fill", host: "example.com", outcome: "success" },
    { action: "click", host: "example.com", outcome: "error" },
    { action: "navigate", host: null, outcome: "error" },
  ]);
  expect(rows.every(row => row.agentId === "a" && row.runId === "r" && row.actorKind === "agent")).toBe(true);
  expect(driver.released).toBe(3);
});
test("refuses unrelated principals before contacting the driver", async () => {
  for (const caller of [{ ...principal, workspaceId: "other" }, { ...principal, agentId: "other" }, { kind: "user", workspaceId: "w", userId: "u", via: "session" }] satisfies Principal[]) {
    await expect(service.snapshot(caller)).rejects.toBeInstanceOf(ForbiddenError);
  }
  expect(driver.launches).toBe(0);
});
