import type { Database } from "@repo/db";
import type { Atomic, Statement } from "@repo/db/atomic";
import { libraryEntries, wikiSuggestions } from "@repo/db/schema/library";
import { LIBRARY_FILE_MAX_BYTES } from "@repo/db/shared";
import { and, asc, eq, inArray } from "drizzle-orm";
import { ulid } from "ulidx";
import { z } from "zod";
import { authorize, ForbiddenError } from "../authz.ts";
import { ServiceError } from "../errors.ts";
import type { EventsService } from "../events.ts";
import { normalizePath } from "../library/path.ts";
import { createVersionStore } from "../library/versions.ts";
import type { LibraryBlobs, LibraryService } from "../library.ts";
import type { Clock } from "../runs/types.ts";
import type { Principal } from "../workspaces.ts";

export const suggestionDecisionSchema = z.union([
  z.strictObject({ accept: z.literal(true), body: z.string().optional() }),
  z.strictObject({ reject: z.literal(true) }),
]);
export type SuggestionDecision = z.input<typeof suggestionDecisionSchema>;
type Suggestion = typeof wikiSuggestions.$inferSelect;
const openStatuses = ["pending", "stale"] as const;

export const createWikiSuggestionsService = ({
  atomic,
  blobs,
  clock,
  db,
  events,
  library,
}: {
  atomic: Atomic;
  blobs: LibraryBlobs;
  clock: Clock;
  db: Database;
  events: Pick<EventsService, "insertStatement">;
  library: LibraryService;
}) => {
  const history = createVersionStore({ atomic, blobs, db });
  const member = (principal: Principal, write = false) => {
    if (
      (principal.kind !== "user" && principal.kind !== "run") ||
      (write &&
        principal.kind === "user" &&
        (principal.apiKey?.access === "read" ||
          principal.oauthClient?.access === "read"))
    ) {
      throw new ForbiddenError("wiki.suggestion");
    }
    authorize(principal, "wiki.suggestion", {
      kind: "library",
      workspaceId: principal.workspaceId,
    });
    return principal;
  };
  const whereId = (workspaceId: string, id: string) =>
    and(
      eq(wikiSuggestions.workspaceId, workspaceId),
      eq(wikiSuggestions.id, id)
    );
  const openWhere = (workspaceId: string) =>
    and(
      eq(wikiSuggestions.workspaceId, workspaceId),
      inArray(wikiSuggestions.status, [...openStatuses])
    );
  const find = async (workspaceId: string, id: string) => {
    const [row] = await db
      .select()
      .from(wikiSuggestions)
      .where(whereId(workspaceId, id))
      .limit(1);
    if (!row) {
      throw new ServiceError("not_found", "Suggestion not found");
    }
    return row;
  };
  const latest = async (workspaceId: string, path: string) =>
    (await history.list(workspaceId, path))[0] ?? null;
  const refresh = async (row: Suggestion): Promise<Suggestion> => {
    if (
      row.status === "pending" &&
      (await latest(row.workspaceId, row.path))?.id !==
        (row.baseVersionId ?? undefined)
    ) {
      await atomic([
        db
          .update(wikiSuggestions)
          .set({ status: "stale" })
          .where(
            and(
              whereId(row.workspaceId, row.id),
              eq(wikiSuggestions.status, "pending")
            )
          ),
      ]);
      return { ...row, status: "stale" };
    }
    return row;
  };
  const event = (
    row: Suggestion,
    principal: Principal,
    decision?: "accepted" | "rejected",
    resultVersionId?: string,
    replacedBy?: string
  ) => {
    if (principal.kind !== "user" && principal.kind !== "run") {
      throw new ForbiddenError("wiki.suggestion");
    }
    return events.insertStatement({
      actor:
        principal.kind === "user"
          ? { id: principal.userId, kind: "user" }
          : { id: principal.agentId, kind: "agent" },
      agentId: row.agentId,
      payload: {
        baseVersionId: row.baseVersionId,
        id: row.id,
        path: row.path,
        ...(decision
          ? { decision, resultVersionId: resultVersionId ?? null }
          : { summary: row.summary }),
        ...(replacedBy ? { replacedBy } : {}),
      },
      runId: row.runId,
      type: decision ? "wiki.suggestion.decided" : "wiki.suggestion",
      workspaceId: row.workspaceId,
    });
  };
  const encode = (body: string) => {
    const bytes = new TextEncoder().encode(z.string().parse(body));
    if (bytes.byteLength > LIBRARY_FILE_MAX_BYTES) {
      throw new ServiceError(
        "invalid",
        "Wiki suggestions are limited to 10 MB"
      );
    }
    return bytes;
  };
  const suggest = async (
    principal: Principal,
    rawPath: string,
    body: string,
    rawSummary: string
  ) => {
    const caller = member(principal, true);
    if (caller.kind !== "run" || caller.dryRun) {
      throw new ForbiddenError("wiki.suggestion");
    }
    const path = normalizePath(rawPath);
    if (!(path.startsWith("wiki/") && path.endsWith(".md"))) {
      throw new ServiceError(
        "invalid",
        "A suggestion must name a wiki/**/*.md page"
      );
    }
    const bytes = encode(body);
    const summary = z.string().trim().min(1).max(2000).parse(rawSummary);
    const [entry] = await db
      .select()
      .from(libraryEntries)
      .where(
        and(
          eq(libraryEntries.workspaceId, caller.workspaceId),
          eq(libraryEntries.path, path)
        )
      )
      .limit(1);
    if (entry?.kind === "dir") {
      throw new ServiceError("invalid", "Path is a folder");
    }
    // Legacy unversioned pages need an immutable base for the review diff.
    const seeds = await history.seed(entry ?? null);
    const base = (await latest(caller.workspaceId, path)) ?? seeds[0] ?? null;
    const id = ulid();
    const row: Suggestion = {
      agentId: caller.agentId,
      baseVersionId: base?.id ?? null,
      blobKey: `${caller.workspaceId}/wiki-suggestions/${id}`,
      createdAt: clock.now().toISOString(),
      decidedAt: null,
      decidedBy: null,
      id,
      path,
      resultVersionId: null,
      runId: caller.runId,
      status: "pending",
      summary,
      workspaceId: caller.workspaceId,
    };
    if (!(await blobs.put(row.blobKey, bytes))) {
      throw new ServiceError("conflict", "Could not store suggestion bytes");
    }
    // Replacement closes the old proposal rather than overwriting its audit history.
    const replaced = await db
      .select()
      .from(wikiSuggestions)
      .where(
        and(
          openWhere(caller.workspaceId),
          eq(wikiSuggestions.agentId, caller.agentId),
          eq(wikiSuggestions.path, path)
        )
      );
    await atomic([
      ...seeds.map(history.insertSeed),
      db
        .update(wikiSuggestions)
        .set({ decidedAt: row.createdAt, status: "rejected" })
        .where(
          and(
            openWhere(caller.workspaceId),
            eq(wikiSuggestions.agentId, caller.agentId),
            eq(wikiSuggestions.path, path)
          )
        ),
      ...replaced.map((old) => event(old, caller, "rejected", undefined, id)),
      db.insert(wikiSuggestions).values(row),
      event(row, caller),
    ]);
    return row;
  };
  const list = async (principal: Principal) => {
    const caller = member(principal);
    const rows = await db
      .select()
      .from(wikiSuggestions)
      .where(openWhere(caller.workspaceId))
      .orderBy(asc(wikiSuggestions.createdAt), asc(wikiSuggestions.id));
    // Stale proposals remain actionable in Needs you, with an edited body required.
    return await Promise.all(rows.map(refresh));
  };
  const baseBytes = async (row: Suggestion) => {
    if (!row.baseVersionId) {
      return;
    }
    const version = await history.get(row.workspaceId, row.baseVersionId);
    // A deletion is a version too; its diff base is an absent (empty) page.
    return version.op === "delete"
      ? undefined
      : (await history.read(row.workspaceId, version.id)).bytes;
  };
  const get = async (principal: Principal, id: string) => {
    const caller = member(principal);
    const row = await refresh(await find(caller.workspaceId, id));
    const [base, proposed] = await Promise.all([
      baseBytes(row),
      blobs.get(row.blobKey),
    ]);
    if (!proposed) {
      throw new ServiceError("not_found", "Suggestion bytes not found");
    }
    return {
      ...row,
      baseText: new TextDecoder().decode(base),
      proposedText: new TextDecoder().decode(proposed.bytes),
    };
  };
  const acceptedBytes = async (row: Suggestion, body?: string) => {
    if (body !== undefined) {
      return encode(body);
    }
    const proposed = await blobs.get(row.blobKey);
    if (!proposed) {
      throw new ServiceError("not_found", "Suggestion bytes not found");
    }
    return proposed.bytes;
  };
  const accept = async (
    caller: Extract<Principal, { kind: "user" }>,
    row: Suggestion,
    body: string | undefined,
    statements: (versionId: string) => Statement[]
  ) => {
    const current = await latest(caller.workspaceId, row.path);
    if (
      body === undefined &&
      (row.status === "stale" || (current?.id ?? null) !== row.baseVersionId)
    ) {
      await refresh(row);
      throw new ServiceError(
        "conflict",
        "The page changed; an edited body is required"
      );
    }
    if (!row.runId) {
      throw new ServiceError("invalid", "Suggestion has no proposing run");
    }
    const bytes = await acceptedBytes(row, body);
    // The person authorizes the write; no grant is added to the proposing agent.
    await library.writeApproved(caller, row.path, bytes, {
      author: {
        agentId: row.agentId,
        kind: "run",
        runId: row.runId,
        workspaceId: row.workspaceId,
      },
      ifEtag: current?.op === "delete" ? undefined : current?.etag,
      statements: (version) => statements(version.id),
    });
  };
  const decide = async (
    principal: Principal,
    id: string,
    rawDecision: SuggestionDecision
  ) => {
    const caller = member(principal, true);
    if (caller.kind !== "user") {
      throw new ForbiddenError("wiki.suggestion.decide");
    }
    const decision = suggestionDecisionSchema.parse(rawDecision);
    const row = await refresh(await find(caller.workspaceId, id));
    if (row.status !== "pending" && row.status !== "stale") {
      throw new ServiceError("conflict", "Suggestion is already decided");
    }
    const decidedAt = clock.now().toISOString();
    const statements = (
      status: "accepted" | "rejected",
      resultVersionId: string | null
    ): Statement[] => [
      db
        .update(wikiSuggestions)
        .set({ decidedAt, decidedBy: caller.userId, resultVersionId, status })
        .where(whereId(caller.workspaceId, id)),
      event(row, caller, status, resultVersionId ?? undefined),
    ];
    if ("reject" in decision) {
      await atomic(statements("rejected", null));
    } else {
      await accept(caller, row, decision.body, (versionId) =>
        statements("accepted", versionId)
      );
    }
    return await find(caller.workspaceId, id);
  };
  return { decide, get, list, suggest };
};

export type WikiSuggestionsService = ReturnType<
  typeof createWikiSuggestionsService
>;
