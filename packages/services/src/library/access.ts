import type { Database } from "@repo/db";
import type { Atomic } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import { agentLibraryAccess } from "@repo/db/schema/library";
import type { LibraryAccessGrant, LibraryAccessMode } from "@repo/db/shared";
import { and, asc, eq } from "drizzle-orm";
import { authorize, ForbiddenError } from "../authz.ts";
import { ServiceError } from "../errors.ts";
import type { EventsService } from "../events.ts";
import type { Clock } from "../runs/types.ts";
import type { Principal } from "../workspaces.ts";
import { normalizePath } from "./path.ts";

/** Internal workspace-scoped lookup; callers authorize before reading. */
export const agentGrants = (
  db: Database,
  workspaceId: string,
  agentId: string
): Promise<LibraryAccessGrant[]> =>
  db
    .select({ mode: agentLibraryAccess.mode, path: agentLibraryAccess.path })
    .from(agentLibraryAccess)
    .where(
      and(
        eq(agentLibraryAccess.workspaceId, workspaceId),
        eq(agentLibraryAccess.agentId, agentId)
      )
    )
    .orderBy(asc(agentLibraryAccess.path));

export const createLibraryAccessService = ({
  db,
  atomic,
  clock,
  events,
}: {
  db: Database;
  atomic: Atomic;
  clock: Clock;
  events: Pick<EventsService, "insertStatement">;
}) => {
  const person = async (
    principal: Principal,
    agentId: string,
    write = false
  ) => {
    if (
      principal.kind !== "user" ||
      (write &&
        (principal.apiKey?.access === "read" ||
          principal.oauthClient?.access === "read"))
    ) {
      throw new ForbiddenError("library.access");
    }
    authorize(principal, "library.access", {
      id: agentId,
      kind: "agent",
      workspaceId: principal.workspaceId,
    });
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.id, agentId),
          eq(agents.workspaceId, principal.workspaceId)
        )
      )
      .limit(1);
    if (!agent) {
      throw new ServiceError("not_found", "Agent not found");
    }
    return principal;
  };
  const event = (
    user: Extract<Principal, { kind: "user" }>,
    agentId: string,
    payload: Record<string, unknown>
  ) =>
    events.insertStatement({
      actor: { id: user.userId, kind: "user" },
      agentId,
      payload,
      type: "library.access",
      workspaceId: user.workspaceId,
    });
  const grantPath = (raw: string) => {
    const path = normalizePath(raw);
    if (path === "") {
      throw new ServiceError(
        "invalid",
        "A grant must name a folder in the library"
      );
    }
    return path;
  };
  const listGrants = async (principal: Principal, agentId: string) => {
    const user = await person(principal, agentId);
    const grants = await agentGrants(db, user.workspaceId, agentId);
    // Access administration, including inspection, is audited as library.access.
    await atomic([event(user, agentId, { operation: "list" })]);
    return grants;
  };
  const setGrant = async (
    principal: Principal,
    agentId: string,
    rawPath: string,
    mode: LibraryAccessMode
  ) => {
    const user = await person(principal, agentId, true);
    const path = grantPath(rawPath);
    if (mode !== "read" && mode !== "write") {
      throw new ServiceError("invalid", "Unknown library access mode");
    }
    await atomic([
      db
        .insert(agentLibraryAccess)
        .values({
          agentId,
          createdAt: clock.now().toISOString(),
          mode,
          path,
          workspaceId: user.workspaceId,
        })
        .onConflictDoUpdate({
          set: { mode },
          target: [agentLibraryAccess.agentId, agentLibraryAccess.path],
        }),
      event(user, agentId, { mode, operation: "set", path }),
    ]);
  };
  const removeGrant = async (
    principal: Principal,
    agentId: string,
    rawPath: string
  ) => {
    const user = await person(principal, agentId, true);
    const path = grantPath(rawPath);
    await atomic([
      db
        .delete(agentLibraryAccess)
        .where(
          and(
            eq(agentLibraryAccess.workspaceId, user.workspaceId),
            eq(agentLibraryAccess.agentId, agentId),
            eq(agentLibraryAccess.path, path)
          )
        ),
      event(user, agentId, { operation: "remove", path }),
    ]);
  };
  return { listGrants, removeGrant, setGrant };
};

export type LibraryAccessService = ReturnType<
  typeof createLibraryAccessService
>;
