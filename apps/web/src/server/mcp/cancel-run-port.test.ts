import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { migrated } from "@repo/db/test-db";
import { ToolError } from "@repo/mcp/result";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import type { Principal } from "@repo/services/workspaces";
import { type Composed, composeWith } from "../compose.ts";
import { createMcpPorts } from "./ports.ts";

let composed: Composed;
let userPrincipal: Principal;

beforeEach(async () => {
  const db = migrated(["org_a"]);
  const store = new Map<string, string>();
  composed = composeWith({
    db,
    infra: {
      atomic: sqliteAtomic(db),
      blobs: {
        get: (key) => Promise.resolve(store.get(key) ?? null),
        put: (key, body) => {
          store.set(key, body);
          return Promise.resolve();
        },
      },
      clock: {
        now: () => new Date("2026-10-19T08:00:00.000Z"),
        sleep: systemClock.sleep,
      },
      devFakeRuntime: true,
      fileBlobs: memoryFileBlobs(),
      relay: noopRelay,
    },
  });
  const workspace = await composed.services.workspaces.forOrg({
    clerkOrgId: "org_a",
  });
  if (!workspace) {
    throw new Error("the test organisation is not allowed");
  }
  userPrincipal = {
    kind: "user",
    userId: "user_1",
    via: "session",
    workspaceId: workspace.id,
  };
});

test("cancelRun on a run that does not exist is a not_found ToolError", async () => {
  const ports = createMcpPorts({
    principal: userPrincipal,
    services: composed.services,
  });
  const failure = await ports
    .cancelRun({ runId: "run_missing" })
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ToolError);
  expect((failure as ToolError).code).toBe("not_found");
});
