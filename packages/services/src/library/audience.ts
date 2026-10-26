// Who has to hear about a library change: the running runs whose sync scope
// covers a changed path. The app's notifier sends each its frame or RPC.
import type { Database } from "@repo/db";
import { agents } from "@repo/db/schema/agents";
import { runs } from "@repo/db/schema/runs";
import type { LibraryChange } from "@repo/db/shared";
import { and, eq, inArray } from "drizzle-orm";
import { cloudEnvironmentOf } from "../cloud/environment.ts";
import { agentGrants } from "./access.ts";
import { librarySyncScope } from "./sync-paths.ts";

/** The runs that take the change, with the changed paths each one covers. */
export interface LibraryAudience {
  /** Runs in a Linux VM, one entry per session. */
  cloud: { paths: string[]; sessionId: string }[];
  /** One entry per machine, with the paths of all its covered runs. */
  machines: { machineId: string; paths: string[] }[];
}

const runtimeConfigOf = (raw: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed))
      : {};
  } catch {
    return {};
  }
};

interface RunRow {
  claimedBy: string | null;
  dryRun: boolean;
  id: string;
  runtime: string;
  runtimeConfig: string;
  sessionId: string;
}

/** Where a run hears about a change, or null when it does not. */
const targetOf = (
  row: RunRow,
  byRunId: string | null
): { key: string; kind: "cloud" | "machine" } | null => {
  if (row.id === byRunId) {
    return null;
  }
  if (row.runtime === "machine") {
    return row.claimedBy ? { key: row.claimedBy, kind: "machine" } : null;
  }
  const inVm =
    !row.dryRun &&
    cloudEnvironmentOf(runtimeConfigOf(row.runtimeConfig)) === "linux-vm";
  return inVm ? { key: row.sessionId, kind: "cloud" } : null;
};

const isCovered = (root: string, path: string): boolean =>
  root === "" || path === root || path.startsWith(`${root}/`);

/**
 * The running runs of the change's workspace whose agent syncs one of the
 * changed paths, leaving out the run that made the change. A machine run goes
 * by the machine that claimed it. A cloud run counts only in a Linux VM,
 * because an isolate reads the library directly.
 */
export const createLibraryAudience =
  ({ db }: { db: Database }) =>
  async (change: LibraryChange): Promise<LibraryAudience> => {
    const rows = await db
      .select({
        agentId: runs.agentId,
        claimedBy: runs.claimedBy,
        dryRun: runs.dryRun,
        id: runs.id,
        runtime: agents.runtime,
        runtimeConfig: agents.runtimeConfig,
        sessionId: runs.sessionId,
        slug: agents.slug,
      })
      .from(runs)
      .innerJoin(agents, eq(agents.id, runs.agentId))
      .where(
        and(
          eq(runs.workspaceId, change.workspaceId),
          eq(runs.status, "running"),
          inArray(agents.runtime, ["machine", "cloud"])
        )
      );
    const machines = new Map<string, Set<string>>();
    const cloud = new Map<string, Set<string>>();
    const scopes = new Map<string, string[]>();
    const add = (
      into: Map<string, Set<string>>,
      key: string,
      paths: string[]
    ) => {
      const set = into.get(key) ?? new Set<string>();
      for (const path of paths) {
        set.add(path);
      }
      into.set(key, set);
    };
    for (const row of rows) {
      const target = targetOf(row, change.byRunId);
      if (!target) {
        continue;
      }
      let roots = scopes.get(row.agentId);
      if (!roots) {
        // biome-ignore lint/performance/noAwaitInLoops: one lookup per agent, cached
        const grants = await agentGrants(db, change.workspaceId, row.agentId);
        roots = librarySyncScope(row.slug, grants).map((grant) => grant.path);
        scopes.set(row.agentId, roots);
      }
      const covered = change.paths.filter((path) =>
        roots.some((root) => isCovered(root, path))
      );
      if (covered.length > 0) {
        add(target.kind === "machine" ? machines : cloud, target.key, covered);
      }
    }
    return {
      cloud: [...cloud].map(([sessionId, paths]) => ({
        paths: [...paths],
        sessionId,
      })),
      machines: [...machines].map(([machineId, paths]) => ({
        machineId,
        paths: [...paths],
      })),
    };
  };
