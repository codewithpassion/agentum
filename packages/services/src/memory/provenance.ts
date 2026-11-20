// Who is writing a note and where the note came from. The service uses this to
// pick the file (shared or private), to hold notes that outside text could have
// written, and to refuse the writers that may never remember anything.
import type { Database } from "@repo/db";
import { events } from "@repo/db/schema/events";
import { runRequests } from "@repo/db/schema/requests";
import { sessions } from "@repo/db/schema/sessions";
import type { MemorySource } from "@repo/db/shared";
import { and, eq, inArray, isNotNull, like, or, sql } from "drizzle-orm";
import { authorize, ForbiddenError } from "../authz.ts";
import { isReadOnly } from "../automation-access.ts";
import { invalid, notFound } from "../errors.ts";
import { readableWorkspace } from "../guards.ts";
import { peerRootOf } from "../runs/peer-root.ts";
import { loadRun } from "../runs/queries.ts";
import type { Principal } from "../workspaces.ts";
import { type OutsideSource, outsideSourceOf } from "./guards.ts";

export const MEMORY_READ = "memory.read";
export const MEMORY_WRITE = "memory.write";
export const MEMORY_KIND = "memory";

// A private file is named after a Clerk user id, see `PRIVATE_PATH` in codec.ts.
const USER_ID = /^user_[A-Za-z0-9]+$/;

// Tool calls that bring outside text into a run, by lower-cased name. Claude Code
// on a machine records `WebFetch` and `WebSearch`, Managed Agents and Pi record
// `web_fetch` and `web_search`. Every runtime stores a call as a `tool.call`
// event whose payload has the tool's `name`.
const WEB_TOOLS = ["webfetch", "websearch", "web_fetch", "web_search"];
// A real shell can run `curl` with nothing in the log: Claude Code's `Bash`, the
// `bash` of Managed Agents and of a cloud Linux VM, and the computer's shell
// (`computer_exec`, named `mcp__<server>__computer_exec` on a machine). A run
// that called one is treated as having used the web. See docs/v4/memory-format.md.
const SHELL_TOOLS = ["bash"];
const COMPUTER_SHELL_NAME = "%computer_exec";
const toolName = sql`lower(json_extract(${events.payload}, '$.name'))`;

export const isUserId = (value: string | null): value is string =>
  value !== null && USER_ID.test(value);

/** The caller of a memory method, after the checks that every method shares. */
export interface MemoryActor {
  principal: Principal;
  /** The person's own id, or the person a run works for. Names the private file the caller sees. */
  userId: string | null;
  workspaceId: string;
  /** `person` for a user, `agent` for a run. Dreams will write as `dream`. */
  writer: "agent" | "person";
}

/** Where a note came from and what that means for it. */
export interface Provenance {
  /** Set when the source is outside text, whatever the learn level says. */
  outside: OutsideSource | null;
  source: MemorySource | null;
  /** The person whose private file the note goes to, or null for a shared note. */
  userScope: string | null;
}

const NO_PROVENANCE: Provenance = {
  outside: null,
  source: null,
  userScope: null,
};

export const createMemoryActors = ({ db }: { db: Database }) => {
  const runActor = async (
    principal: Extract<Principal, { kind: "run" }>,
    workspaceId: string,
    mode: "read" | "write"
  ): Promise<MemoryActor> => {
    const action = mode === "read" ? MEMORY_READ : MEMORY_WRITE;
    const run = await loadRun(db, principal.runId, workspaceId);
    // The stored run is the truth: a principal that names another agent is refused.
    if (!run || run.agentId !== principal.agentId) {
      throw new ForbiddenError(action);
    }
    if (mode === "write") {
      if (principal.dryRun || run.dryRun) {
        throw new ForbiddenError(action);
      }
      // A peer's text is outside input, so a run it set going cannot remember or forget.
      if ((await peerRootOf(db, run)) !== null) {
        throw new ForbiddenError("memory.write by a peer-origin run");
      }
    }
    return {
      principal,
      userId: run.onBehalfOfUserId,
      workspaceId,
      writer: "agent",
    };
  };

  const actorFor = async (
    principal: Principal,
    mode: "read" | "write",
    agentId: string
  ): Promise<MemoryActor> => {
    const action = mode === "read" ? MEMORY_READ : MEMORY_WRITE;
    const workspaceId = readableWorkspace(principal, action);
    authorize(principal, action, {
      id: agentId,
      kind: MEMORY_KIND,
      workspaceId,
    });
    if (principal.kind === "user") {
      if (mode === "write" && isReadOnly(principal)) {
        throw new ForbiddenError(action);
      }
      return {
        principal,
        userId: principal.userId,
        workspaceId,
        writer: "person",
      };
    }
    // Machines, triggers and peers never touch memory. A run touches only its own agent's.
    if (principal.kind !== "run" || principal.agentId !== agentId) {
      throw new ForbiddenError(action);
    }
    return await runActor(principal, workspaceId, mode);
  };

  /** A person, for the methods a run may never call: decide and undo. */
  const personFor = (
    principal: Principal,
    action: string
  ): { userId: string; workspaceId: string } => {
    const workspaceId = readableWorkspace(principal, action);
    authorize(principal, action, { kind: MEMORY_KIND, workspaceId });
    if (principal.kind !== "user" || isReadOnly(principal)) {
      throw new ForbiddenError(action);
    }
    return { userId: principal.userId, workspaceId };
  };

  const sessionOf = async (
    workspaceId: string,
    agentId: string,
    id: string
  ) => {
    const [session] = await db
      .select({
        actorId: sessions.actorId,
        actorKind: sessions.actorKind,
        origin: sessions.origin,
        private: sessions.private,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.id, id),
          eq(sessions.workspaceId, workspaceId),
          eq(sessions.agentId, agentId)
        )
      )
      .limit(1);
    if (!session) {
      throw invalid("Unknown source");
    }
    return session;
  };

  /**
   * True when the run could have read outside text. Any `network.request` counts,
   * whatever its `via` (`curl`, `run_script` or `web_fetch`), and so does a
   * `browser.action`, a web tool call, and a shell call. A tool call whose
   * payload went to the blob store keeps no name in the row, so it counts too.
   */
  const usedWeb = async (runId: string): Promise<boolean> => {
    const [row] = await db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.runId, runId),
          or(
            inArray(events.type, ["browser.action", "network.request"]),
            and(
              eq(events.type, "tool.call"),
              or(
                inArray(toolName, [...WEB_TOOLS, ...SHELL_TOOLS]),
                like(toolName, COMPUTER_SHELL_NAME),
                isNotNull(events.payloadRef)
              )
            )
          )
        )
      )
      .limit(1);
    return row !== undefined;
  };

  /** A private conversation keeps its notes in the file of the person it belongs to. */
  const scopeOf = (
    session: { actorId: string; actorKind: string; private: boolean },
    // A run's note goes to the person the run works for, because the library
    // lets a run see only that person's private file. A person's own note goes
    // to the person who opened the conversation.
    owner: { runUserId: string | null } | "session-actor"
  ): string | null => {
    if (!session.private) {
      return null;
    }
    const sessionActor = session.actorKind === "user" ? session.actorId : null;
    const userId = owner === "session-actor" ? sessionActor : owner.runUserId;
    if (!isUserId(userId)) {
      throw invalid(
        "This conversation is private and has no person to keep the note for"
      );
    }
    return userId;
  };

  const sessionIdOfRequest = async (
    workspaceId: string,
    id: string
  ): Promise<string> => {
    const [request] = await db
      .select({ sessionId: runRequests.sessionId })
      .from(runRequests)
      .where(
        and(eq(runRequests.id, id), eq(runRequests.workspaceId, workspaceId))
      )
      .limit(1);
    if (!request) {
      throw invalid("Unknown source");
    }
    return request.sessionId;
  };

  const resolveSource = async (
    workspaceId: string,
    agentId: string,
    source: MemorySource
  ): Promise<Provenance> => {
    if (source.kind === "run") {
      const run = await loadRun(db, source.id, workspaceId);
      if (!run || run.agentId !== agentId) {
        throw invalid("Unknown source");
      }
      const session = await sessionOf(workspaceId, agentId, run.sessionId);
      return {
        outside: outsideSourceOf({
          origin: session.origin,
          peer: (await peerRootOf(db, run)) !== null,
          web: await usedWeb(run.id),
        }),
        source,
        userScope: scopeOf(session, { runUserId: run.onBehalfOfUserId }),
      };
    }
    const sessionId =
      source.kind === "session"
        ? source.id
        : await sessionIdOfRequest(workspaceId, source.id);
    const session = await sessionOf(workspaceId, agentId, sessionId);
    return {
      outside: outsideSourceOf({
        origin: session.origin,
        peer: false,
        web: false,
      }),
      source,
      userScope: scopeOf(session, "session-actor"),
    };
  };

  /**
   * The provenance of a write. A run always writes as itself, so its source is
   * its own run. A person may name the conversation they are remembering from,
   * and can only fill their own private file.
   */
  const provenanceOf = async (
    actor: MemoryActor,
    agentId: string,
    requested: MemorySource | undefined
  ): Promise<Provenance> => {
    const { principal } = actor;
    if (principal.kind === "run") {
      if (
        requested &&
        !(requested.kind === "run" && requested.id === principal.runId)
      ) {
        throw invalid("A run writes notes as itself");
      }
      return await resolveSource(actor.workspaceId, agentId, {
        id: principal.runId,
        kind: "run",
      });
    }
    if (!requested) {
      return NO_PROVENANCE;
    }
    const provenance = await resolveSource(
      actor.workspaceId,
      agentId,
      requested
    );
    if (
      provenance.userScope !== null &&
      provenance.userScope !== actor.userId
    ) {
      throw notFound("Unknown source");
    }
    return provenance;
  };

  return { actorFor, personFor, provenanceOf };
};
