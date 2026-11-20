// Who is writing a note and where the note came from. The service uses this to
// pick the file (shared or private), to hold notes that outside text could have
// written, and to refuse the writers that may never remember anything.
import type { Database } from "@repo/db";
import { events } from "@repo/db/schema/events";
import { runRequests } from "@repo/db/schema/requests";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import type { MemorySource } from "@repo/db/shared";
import { and, eq, inArray, isNotNull, like, or, sql } from "drizzle-orm";
import { authorize, ForbiddenError } from "../authz.ts";
import { isReadOnly } from "../automation-access.ts";
import { invalid, notFound } from "../errors.ts";
import { readableWorkspace } from "../guards.ts";
import { peerRootOf } from "../runs/peer-root.ts";
import { loadRun } from "../runs/queries.ts";
import { MAX_RUN_DEPTH } from "../runs/subject.ts";
import { inBatches } from "../tasks/reads.ts";
import type { Principal } from "../workspaces.ts";
import { type OutsideSource, outsideSourceOf } from "./guards.ts";

export const MEMORY_READ = "memory.read";
export const MEMORY_WRITE = "memory.write";
export const MEMORY_KIND = "memory";

// A private file is named after a Clerk user id, see `PRIVATE_PATH` in codec.ts.
const USER_ID = /^user_[A-Za-z0-9]+$/;

// Tool calls that bring outside text into a run, by lower-cased name. Claude Code
// on a machine records `WebFetch` and `WebSearch`, Managed Agents `web_fetch` and
// `web_search`, and Pi `web_fetch`. Every runtime stores a call as a `tool.call`
// event whose payload has the tool's `name`.
const WEB_TOOLS = ["webfetch", "websearch", "web_fetch", "web_search"];
// Real shells, and tools that run code with network access, can fetch a page with
// nothing in the log: Claude Code's `Bash`, the `bash` of Managed Agents and of a
// cloud Linux VM, a skill's script (`run_skill_script`), and the computer's shell
// and desktop (`computer_exec`, `desktop_*`). A run that called one is treated as
// having used the web. See docs/v4/memory-format.md.
const SHELL_TOOLS = ["bash"];
// MCP tools carry a prefix, `mcp__<server>__` on a machine and `<server>_` in Pi,
// so these match as the end of the name.
const UNSEEN_NETWORK_TOOLS = [
  "computer_exec",
  "desktop_act",
  "desktop_act_headed",
  "desktop_input",
  "desktop_screenshot",
  "desktop_snapshot",
  "run_skill_script",
];
const toolName = sql`lower(json_extract(${events.payload}, '$.name'))`;
// The connector proxy writes one `connector.call` event for every call a run
// makes to a connector (MCP server), on every runtime, because every runtime
// reaches connectors through `/api/proxy/<connectorId>` with the run's token.
// The tool call rows cannot say this: Managed Agents keep only the bare tool
// name, Pi renames and cuts it, and a machine's `mcp__harbourmaster__` prefix
// is the platform's own server. `outcome` is `ok` when the connector answered,
// and `method` names what was asked. These methods return text the connector
// chose, so they count. `initialize`, `tools/list` and the notifications,
// which every run with a connector sends, do not.
const CONNECTOR_TEXT_METHODS = ["tools/call", "resources/read", "prompts/get"];
const callOutcome = sql`json_extract(${events.payload}, '$.outcome')`;
const callMethod = sql`json_extract(${events.payload}, '$.method')`;

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
   * Every run that could have handed outside text to this one: the run, the runs
   * it descends from (a subagent's prompt may hold what its parent fetched), and
   * everything below the root of that chain (a parent may remember what its
   * subagent fetched), so a sibling counts too.
   */
  const runFamily = async (
    run: { id: string; parentRunId: string | null },
    workspaceId: string
  ): Promise<string[]> => {
    let root = run;
    for (
      let depth = 0;
      depth <= MAX_RUN_DEPTH + 1 && root.parentRunId;
      depth += 1
    ) {
      // biome-ignore lint/performance/noAwaitInLoops: the chain is at most MAX_RUN_DEPTH long and each step needs the last
      const parent = await loadRun(db, root.parentRunId, workspaceId);
      if (!parent) {
        break;
      }
      root = parent;
    }
    const family = new Set([root.id]);
    let frontier = [root.id];
    for (
      let depth = 0;
      depth <= MAX_RUN_DEPTH + 1 && frontier.length > 0;
      depth += 1
    ) {
      // biome-ignore lint/performance/noAwaitInLoops: each level needs the ids of the one above
      const children = await inBatches(frontier, (batch) =>
        db
          .select({ id: runs.id })
          .from(runs)
          .where(
            and(
              eq(runs.workspaceId, workspaceId),
              inArray(runs.parentRunId, batch)
            )
          )
      );
      frontier = children
        .map((child) => child.id)
        .filter((id) => !family.has(id));
      for (const id of frontier) {
        family.add(id);
      }
    }
    return [...family];
  };

  /**
   * True when the run, or a run it is chained to, could have read outside text.
   * Any `network.request` counts, whatever its `via` (`curl`, `run_script` or
   * `web_fetch`), and so does a `browser.action`, a web tool call, and a call to
   * a tool that can reach the network unseen. A tool call whose payload went to
   * the blob store keeps no name in the row, so it counts too. So does a
   * connector call that got an answer (`connector.call`, see above).
   */
  const usedWeb = async (
    run: { id: string; parentRunId: string | null },
    workspaceId: string
  ): Promise<boolean> => {
    // A family can pass D1's 100 bound parameters, so the run ids go in batches.
    const rows = await inBatches(await runFamily(run, workspaceId), (batch) =>
      db
        .select({ id: events.id })
        .from(events)
        .where(
          and(
            inArray(events.runId, batch),
            or(
              inArray(events.type, ["browser.action", "network.request"]),
              and(
                eq(events.type, "connector.call"),
                eq(callOutcome, "ok"),
                inArray(callMethod, CONNECTOR_TEXT_METHODS)
              ),
              and(
                eq(events.type, "tool.call"),
                or(
                  inArray(toolName, [...WEB_TOOLS, ...SHELL_TOOLS]),
                  ...UNSEEN_NETWORK_TOOLS.map((name) =>
                    like(toolName, `%${name}`)
                  ),
                  isNotNull(events.payloadRef)
                )
              )
            )
          )
        )
        .limit(1)
    );
    return rows.length > 0;
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
          web: await usedWeb(run, workspaceId),
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

  return { actorFor, personFor, provenanceOf, runFamily, usedWeb };
};
