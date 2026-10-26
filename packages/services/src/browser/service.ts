import type { Database } from "@repo/db";
import type { Atomic } from "@repo/db/atomic";
import { agents, browserSessions } from "@repo/db/schema/agents";
import { runs } from "@repo/db/schema/runs";
import { taskFolderPath } from "@repo/db/shared";
import { and, eq } from "drizzle-orm";
import { authorize, ForbiddenError } from "../authz.ts";
import { ServiceError } from "../errors.ts";
import type { EventsService } from "../events.ts";
import type { LibraryService } from "../library.ts";
import type { Clock } from "../runs/types.ts";
import type { Principal } from "../workspaces.ts";
import {
  isSessionStale,
  KEEP_ALIVE_MS,
  validateFillValue,
  validateSelector,
  validateUrl,
} from "./rules.ts";
import { buildSnapshot } from "./snapshot.ts";
import type { BrowserDriver, BrowserPage } from "./types.ts";

type RunPrincipal = Extract<Principal, { kind: "run" }>;
type Action = "navigate" | "snapshot" | "click" | "fill" | "screenshot";
const unavailable = () =>
  new ServiceError(
    "conflict",
    "The browser is unavailable right now. Wait a moment and retry."
  );
const validText = (result: ReturnType<typeof validateSelector>): string => {
  if (!result.ok) {
    throw new ServiceError("invalid", result.reason);
  }
  return result.value;
};
// Events deliberately replace agentum's activity summaries: no titles, text,
// selectors, field values, URL paths, queries or driver error messages are stored.
const hostOf = (url: string | null): string | null => {
  const result = validateUrl(url);
  return result.ok ? new URL(result.url).hostname : null;
};

export const createBrowserService = ({
  db,
  atomic,
  clock,
  driver,
  events,
  library,
}: {
  db: Database;
  atomic: Atomic;
  clock: Pick<Clock, "now">;
  driver: BrowserDriver;
  events: Pick<EventsService, "insertStatement">;
  library: Pick<LibraryService, "write">;
}) => {
  const context = async (principal: Principal) => {
    // Tools act as the run itself, which also owns its screenshot output folder.
    if (principal.kind !== "run") {
      throw new ForbiddenError("browser.action");
    }
    authorize(principal, "browser.action", {
      kind: "browser",
      workspaceId: principal.workspaceId,
    });
    const [row] = await db
      .select({ slug: agents.slug })
      .from(agents)
      .innerJoin(runs, eq(runs.agentId, agents.id))
      .where(
        and(
          eq(agents.id, principal.agentId),
          eq(agents.workspaceId, principal.workspaceId),
          eq(runs.id, principal.runId),
          eq(runs.workspaceId, principal.workspaceId)
        )
      );
    if (!row) {
      throw new ForbiddenError("browser.action");
    }
    return { principal, slug: row.slug };
  };
  const event = (
    principal: RunPrincipal,
    action: Action,
    host: string | null,
    outcome: "success" | "error"
  ) =>
    events.insertStatement({
      actor: { id: principal.agentId, kind: "agent" },
      agentId: principal.agentId,
      payload: { action, host, outcome },
      runId: principal.runId,
      type: "browser.action",
      workspaceId: principal.workspaceId,
    });
  const attach = async (principal: RunPrincipal) => {
    const [row] = await db
      .select()
      .from(browserSessions)
      .where(
        and(
          eq(browserSessions.agentId, principal.agentId),
          eq(browserSessions.workspaceId, principal.workspaceId)
        )
      );
    if (
      row &&
      !isSessionStale(Date.parse(row.updatedAt), clock.now().getTime())
    ) {
      try {
        return {
          page: await driver.connect(row.sessionId),
          sessionId: row.sessionId,
        };
      } catch {
        /* Browser Run may evict a session before its idle deadline. */
      }
    }
    return driver.launch({ keepAliveMs: KEEP_ALIVE_MS });
  };
  const perform = async <T>(
    principal: Principal,
    action: Action,
    prepare: () => { url?: string; selector?: string; value?: string },
    operation: (
      page: BrowserPage,
      input: ReturnType<typeof prepare>,
      slug: string
    ) => Promise<T>
  ): Promise<T> => {
    const member = await context(principal);
    let attached: Awaited<ReturnType<typeof attach>> | undefined;
    let host: string | null = null;
    let recorded = false;
    try {
      const input = prepare();
      host = hostOf(input.url ?? null);
      attached = await attach(member.principal);
      // Persist a newly launched id before actions, so a failed action can retry
      // on the same page. Browser operations cannot be rolled back with D1.
      await atomic([
        db
          .insert(browserSessions)
          .values({
            agentId: member.principal.agentId,
            currentUrl: null,
            sessionId: attached.sessionId,
            updatedAt: clock.now().toISOString(),
            workspaceId: member.principal.workspaceId,
          })
          .onConflictDoUpdate({
            set: {
              sessionId: attached.sessionId,
              updatedAt: clock.now().toISOString(),
            },
            target: browserSessions.agentId,
          }),
      ]);
      if (!input.url) {
        host = hostOf((await attached.page.snapshot()).url);
      }
      const result = await operation(attached.page, input, member.slug);
      const snapshot = await attached.page.snapshot();
      host = hostOf(snapshot.url);
      await atomic([
        db
          .update(browserSessions)
          .set({
            currentUrl: snapshot.url,
            updatedAt: clock.now().toISOString(),
          })
          .where(eq(browserSessions.agentId, member.principal.agentId)),
        event(member.principal, action, host, "success"),
      ]);
      recorded = true;
      return result;
    } catch (error) {
      if (!recorded) {
        await atomic([event(member.principal, action, host, "error")]);
      }
      if (error instanceof ServiceError) {
        throw error;
      }
      throw unavailable();
    } finally {
      // Disconnect must leave Browser Run alive for the next call. A disconnect
      // failure must not change an action whose outcome was already committed.
      // biome-ignore lint/suspicious/noUnnecessaryConditions: prepare or attach may throw before assignment
      await attached?.page.release().catch(() => undefined);
    }
  };
  return {
    click: (principal: Principal, selector: string) =>
      perform(
        principal,
        "click",
        () => ({ selector: validText(validateSelector(selector)) }),
        async (page, input) => {
          await page.click(input.selector ?? "");
          return buildSnapshot(await page.snapshot());
        }
      ),
    fill: (principal: Principal, selector: string, value: string) =>
      perform(
        principal,
        "fill",
        () => ({
          selector: validText(validateSelector(selector)),
          value: validText(validateFillValue(value)),
        }),
        async (page, input) => {
          await page.fill(input.selector ?? "", input.value ?? "");
          return { selector: input.selector, url: (await page.snapshot()).url };
        }
      ),
    navigate: (principal: Principal, rawUrl: string) =>
      perform(
        principal,
        "navigate",
        () => {
          const result = validateUrl(rawUrl);
          if (!result.ok) {
            throw new ServiceError("invalid", result.reason);
          }
          return { url: result.url };
        },
        async (page, input) => {
          await page.navigate(input.url ?? "");
          return buildSnapshot(await page.snapshot());
        }
      ),
    screenshot: (principal: Principal) =>
      perform(
        principal,
        "screenshot",
        () => ({}),
        async (page, _input, slug) => {
          if (principal.kind !== "run") {
            throw new ForbiddenError("browser.action");
          }
          const bytes = await page.screenshot();
          const path = `${taskFolderPath(slug, principal.runId)}/screenshot-${clock.now().getTime()}-${crypto.randomUUID()}.png`;
          return library.write(principal, path, bytes);
        }
      ),
    snapshot: (principal: Principal) =>
      perform(
        principal,
        "snapshot",
        () => ({}),
        async (page) => buildSnapshot(await page.snapshot())
      ),
  };
};
export type BrowserService = ReturnType<typeof createBrowserService>;
