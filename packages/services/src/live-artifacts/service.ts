import type { Database } from "@repo/db";
import {
  findArtifact,
  findVersionById,
  findVersionByNumber,
  versionFiles,
} from "@repo/db/artifacts";
import type { Atomic, Statement } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import {
  artifacts,
  artifactVersionFiles,
  artifactVersions,
} from "@repo/db/schema/artifacts";
import { artifactMembers } from "@repo/db/schema/live-artifacts";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import {
  ARTIFACT_FILE_MAX_BYTES,
  ARTIFACT_MAX_BYTES,
  LIVE_DOC_MAX_BYTES,
  ROOM_CONNECTION_MINUTES,
  ROOM_TICKET_SECONDS,
} from "@repo/db/shared";
import { contentTypeForPath } from "@repo/protocol/artifacts";
import type { LiveJoinResult, RoomTicketClaims } from "@repo/protocol/live";
import { and, eq, isNull, type SQL } from "drizzle-orm";
import { ulid } from "ulidx";
import {
  blobKey,
  createArtifactBlobWriter,
  manifestKey,
  rethrowArtifactQuotaError,
} from "../artifacts/blob-writer.ts";
import {
  agentCanSee,
  agentCanUpdate,
  defaultAudience,
} from "../artifacts/policy.ts";
import type { ArtifactsService, PublishResult } from "../artifacts/service.ts";
import { authorize, ForbiddenError } from "../authz.ts";
import { isUniqueViolation, ServiceError } from "../errors.ts";
import type { EventsService } from "../events.ts";
import type { LibraryBlobs } from "../library.ts";
import type { Clock } from "../runs/types.ts";
import type { Principal } from "../workspaces.ts";
import { createAccessLifecycle } from "./access-lifecycle.ts";
import { createChangesModule } from "./changes.ts";
import { createCommentsModule } from "./comments.ts";
import type { LiveInteractionPorts } from "./ports.ts";

export type {
  LiveAdmissionPort,
  LiveAnchorPort,
  LiveAskPort,
  LiveChangePort,
  LiveInteractionPorts,
} from "./ports.ts";

import { signRoomTicket, verifyRoomTicket } from "./ticket.ts";

export interface LivePublishResult extends PublishResult {
  revision: number;
}

export interface DocumentSnapshot {
  revision: number;
  state: Uint8Array;
}

/** The implementation must import/sanitize and render with the shared document schema. */
export interface LiveContentCodec {
  exportDocument: (
    snapshot: DocumentSnapshot
  ) => Promise<{ markdown: string; html: string }>;
  importMarkdown: (markdown: string) => Promise<DocumentSnapshot>;
  /** Validate/sanitize stored state before applying a restore. */
  loadDocument: (state: Uint8Array) => Promise<DocumentSnapshot>;
}

export interface LiveRoomScope {
  artifactId: string;
  workspaceId: string;
}

/** Restore must apply state as one live change and return its new, monotonic revision. */
export interface LiveRoomsPort {
  /** Recheck current DB access for one participant, or every connection if omitted. */
  refresh: (scope: LiveRoomScope, participantId?: string) => Promise<void>;
  restore: (
    scope: LiveRoomScope,
    input: {
      snapshot: DocumentSnapshot;
      versionId: string;
      byParticipant: string;
    }
  ) => Promise<DocumentSnapshot>;
  url: (scope: LiveRoomScope) => string;
}

export interface LiveArtifactsDeps extends LiveInteractionPorts {
  artifacts: Pick<ArtifactsService, "readFile" | "setAudience" | "remove">;
  atomic: Atomic;
  blobs: Pick<LibraryBlobs, "get" | "put">;
  clock: Clock;
  content: LiveContentCodec;
  db: Database;
  events: Pick<EventsService, "insertStatement">;
  identity: (
    principal: Extract<Principal, { kind: "user" | "run" }>
  ) => Promise<{ name: string; color: string }>;
  rooms: LiveRoomsPort;
  ticketKey: string;
}

export type Member = Extract<Principal, { kind: "user" | "run" }>;
export type Row = NonNullable<Awaited<ReturnType<typeof findArtifact>>>;
type Role = RoomTicketClaims["role"];
const missing = () =>
  new ServiceError("not_found", "Artifact or checkpoint not found");
const invalid = (message: string) => new ServiceError("invalid", message);
const participantId = (member: Member) =>
  member.kind === "user"
    ? `u:${member.userId}`
    : `a:${member.agentId}:${member.runId}`;
const readOnly = (member: Member) =>
  member.kind === "run"
    ? member.dryRun === true
    : member.apiKey?.access === "read" || member.oauthClient?.access === "read";

const authorOf = (member: Member) =>
  member.kind === "user"
    ? { agentId: null, id: member.userId, kind: "user" as const, runId: null }
    : {
        agentId: member.agentId,
        id: member.agentId,
        kind: "agent" as const,
        runId: member.runId,
      };

const checkSnapshot = (snapshot: DocumentSnapshot) => {
  if (
    !Number.isSafeInteger(snapshot.revision) ||
    snapshot.revision < 0 ||
    snapshot.state.byteLength > LIVE_DOC_MAX_BYTES ||
    snapshot.state.byteLength === 0
  ) {
    throw invalid("Invalid document state or revision");
  }
};

export const createLiveArtifactsService = (deps: LiveArtifactsDeps) => {
  const { db, atomic, blobs, clock, events, rooms, content } = deps;
  if (!deps.ticketKey.trim()) {
    throw invalid("A private room ticket key is required");
  }
  const now = () => clock.now().toISOString();
  const { checkQuota, quotaStatement, writeBlobs, writeManifest } =
    createArtifactBlobWriter({
      blobs,
      db,
    });
  const memberOf = (principal: Principal): Member => {
    if (principal.kind !== "user" && principal.kind !== "run") {
      throw new ForbiddenError("liveArtifacts");
    }
    authorize(principal, "liveArtifacts", {
      kind: "artifact",
      workspaceId: principal.workspaceId,
    });
    return principal;
  };
  const runContext = async (member: Extract<Member, { kind: "run" }>) => {
    const [run] = await db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.id, member.runId),
          eq(runs.workspaceId, member.workspaceId),
          eq(runs.agentId, member.agentId)
        )
      )
      .limit(1);
    const [agent] = await db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.id, member.agentId),
          eq(agents.workspaceId, member.workspaceId)
        )
      )
      .limit(1);
    const [session] = run
      ? await db
          .select()
          .from(sessions)
          .where(
            and(
              eq(sessions.id, run.sessionId),
              eq(sessions.workspaceId, member.workspaceId),
              eq(sessions.agentId, member.agentId)
            )
          )
          .limit(1)
      : [];
    if (!(run && agent && session)) {
      throw missing();
    }
    return { run, session };
  };
  const userRole = async (
    row: Row,
    userId: string,
    admin = false
  ): Promise<Role | null> => {
    if (admin || row.ownerUserId === userId) {
      return "owner";
    }
    const [grant] = await db
      .select()
      .from(artifactMembers)
      .where(
        and(
          eq(artifactMembers.workspaceId, row.workspaceId),
          eq(artifactMembers.artifactId, row.id),
          eq(artifactMembers.principalKind, "user"),
          eq(artifactMembers.userId, userId),
          isNull(artifactMembers.revokedAt)
        )
      )
      .limit(1);
    if (grant && (!grant.expiresAt || grant.expiresAt > now())) {
      return grant.role;
    }
    return row.audience === "workspace" ? "editor" : null;
  };
  const runRole = async (
    member: Extract<Member, { kind: "run" }>,
    row: Row
  ): Promise<Role | null> => {
    const { run } = await runContext(member);
    if (run.scopeArtifactId && run.scopeArtifactId !== row.id) {
      throw new ForbiddenError("liveArtifacts.scope");
    }
    if (run.scopeArtifactId) {
      const asker = run.onBehalfOfUserId
        ? await userRole(row, run.onBehalfOfUserId)
        : null;
      if (!asker) {
        throw new ForbiddenError("liveArtifacts.scope");
      }
      return asker === "owner" ? "editor" : asker;
    }
    if (!agentCanSee(row, member.agentId)) {
      return null;
    }
    return agentCanUpdate(row, member.agentId) ? "editor" : "viewer";
  };
  const access = async (
    principal: Principal,
    artifactId: string,
    write = false,
    owner = false,
    live = true
  ) => {
    const member = memberOf(principal);
    const row = await findArtifact(db, member.workspaceId, artifactId);
    if (!row || (live && row.kind !== "document")) {
      throw missing();
    }
    authorize(member, "liveArtifacts.access", {
      id: row.id,
      kind: "artifact",
      workspaceId: row.workspaceId,
    });
    let role =
      member.kind === "user"
        ? await userRole(row, member.userId, member.isAdmin)
        : await runRole(member, row);
    if (!role) {
      throw missing();
    }
    if (readOnly(member)) {
      role = "viewer";
    }
    if (
      (write && role !== "editor" && role !== "owner") ||
      (owner && role !== "owner")
    ) {
      throw new ForbiddenError("liveArtifacts.write");
    }
    return { member, role, row };
  };
  const event = (
    member: Member,
    row: Row,
    type:
      | "artifact.created"
      | "artifact.published"
      | "artifact.restored"
      | "artifact.live_checkpoint"
      | "artifact.comment_created"
      | "artifact.comment_resolved"
      | "artifact.agent_change_reverted"
      | "artifact.deleted"
      | "artifact.audience_changed",
    payload: Record<string, unknown>,
    condition?: SQL
  ) =>
    events.insertStatement(
      {
        actor: { id: authorOf(member).id, kind: authorOf(member).kind },
        agentId: authorOf(member).agentId,
        payload,
        runId: authorOf(member).runId,
        sessionId: row.sessionId,
        type,
        workspaceId: member.workspaceId,
      },
      condition
    );

  const nextVersion = async (row: Row, revision: number, initial: boolean) => {
    if (!initial && revision <= (row.liveRoomRev ?? -1)) {
      throw new ServiceError("conflict", "Checkpoint revision must advance");
    }
    const parent = row.currentVersionId
      ? await findVersionById(db, row.workspaceId, row.currentVersionId)
      : null;
    if (!initial && (!parent || parent.artifactId !== row.id)) {
      throw missing();
    }
    return (parent?.number ?? 0) + 1;
  };

  const persist = async (
    member: Member,
    row: Row,
    snapshot: DocumentSnapshot,
    initial = false,
    restoredFrom?: number
  ): Promise<LivePublishResult> => {
    checkSnapshot(snapshot);
    const number = await nextVersion(row, snapshot.revision, initial);
    const rendered = await content.exportDocument(snapshot);
    const encoder = new TextEncoder();
    const raw = [
      { bytes: new Uint8Array(snapshot.state), path: "state.ydoc" },
      { bytes: encoder.encode(rendered.markdown), path: "index.md" },
      { bytes: encoder.encode(rendered.html), path: "index.html" },
    ];
    if (
      raw.some((file) => file.bytes.byteLength > ARTIFACT_FILE_MAX_BYTES) ||
      raw.reduce((sum, file) => sum + file.bytes.byteLength, 0) >
        ARTIFACT_MAX_BYTES
    ) {
      throw invalid("Checkpoint exceeds artifact file limits");
    }
    const files = await Promise.all(
      raw.map(async (file) => ({
        ...file,
        contentType: contentTypeForPath(file.path),
        sha256: [
          ...new Uint8Array(await crypto.subtle.digest("SHA-256", file.bytes)),
        ]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join(""),
      }))
    );
    const fresh = await checkQuota(row.workspaceId, files);
    const versionId = ulid();
    await writeBlobs(row.workspaceId, files, fresh);
    await writeManifest(row.workspaceId, {
      entry: "index.html",
      files: files.map((file) => ({
        contentType: file.contentType,
        path: file.path,
        sha256: file.sha256,
        size: file.bytes.byteLength,
      })),
      versionId,
    });
    const totalBytes = files.reduce(
      (sum, file) => sum + file.bytes.byteLength,
      0
    );
    const payload = {
      artifactId: row.id,
      kind: row.kind,
      revision: snapshot.revision,
      runId: authorOf(member).runId,
      sessionId: row.sessionId,
      title: row.title,
      version: number,
      versionId,
    };
    const statements: Statement[] = [
      ...(initial
        ? [
            db.insert(artifacts).values(row),
            event(member, row, "artifact.created", payload),
          ]
        : []),
      db.insert(artifactVersions).values({
        artifactId: row.id,
        authorId: authorOf(member).id,
        authorKind: authorOf(member).kind,
        authorRunId: authorOf(member).runId,
        createdAt: now(),
        entry: "index.html",
        fileCount: files.length,
        id: versionId,
        manifestKey: manifestKey(row.workspaceId, versionId),
        message: `Live checkpoint revision ${snapshot.revision}`,
        number,
        parentNumber: number === 1 ? null : number - 1,
        status: "published",
        totalBytes,
        workspaceId: row.workspaceId,
      }),
      db.insert(artifactVersionFiles).values(
        files.map((file) => ({
          contentType: file.contentType,
          path: file.path,
          sha256: file.sha256,
          size: file.bytes.byteLength,
          versionId,
          workspaceId: row.workspaceId,
        }))
      ),
      db
        .update(artifacts)
        .set({
          currentVersionId: versionId,
          liveRoomRev: snapshot.revision,
          thumbnailKey: null,
          updatedAt: now(),
        })
        .where(
          and(
            eq(artifacts.id, row.id),
            eq(artifacts.workspaceId, row.workspaceId)
          )
        ),
      ...(restoredFrom === undefined
        ? []
        : [
            event(member, row, "artifact.restored", {
              ...payload,
              fromVersion: restoredFrom,
            }),
          ]),
      event(member, row, "artifact.live_checkpoint", payload),
      event(member, row, "artifact.published", payload),
      quotaStatement(row.workspaceId, versionId),
    ];
    try {
      await atomic(statements);
    } catch (error) {
      rethrowArtifactQuotaError(error);
      if (isUniqueViolation(error)) {
        // biome-ignore lint/style/useErrorCause: ServiceError has no cause parameter
        throw new ServiceError("conflict", "A concurrent checkpoint won");
      }
      throw error;
    }
    return {
      artifactId: row.id,
      bytes: totalBytes,
      files: files.length,
      revision: snapshot.revision,
      version: number,
      versionId,
    };
  };

  const documentRow = (
    member: Member,
    title: string,
    context: Awaited<ReturnType<typeof runContext>> | null,
    source: Row | null
  ): Row => {
    const at = now();
    return {
      agentId: member.kind === "run" ? member.agentId : null,
      audience: source?.audience ?? defaultAudience(context?.session ?? null),
      convertedFromId: source?.id ?? null,
      createdAt: at,
      createdById: authorOf(member).id,
      createdByKind: authorOf(member).kind,
      currentVersionId: null,
      deletedAt: null,
      deletedBy: null,
      description: null,
      handedToAgentId: null,
      id: crypto.randomUUID(),
      kind: "document",
      liveRoomRev: null,
      ownerUserId:
        context?.run.onBehalfOfUserId ??
        (member.kind === "user" ? member.userId : null),
      runId: context?.run.id ?? null,
      sessionId: context?.session.id ?? null,
      thumbnailKey: null,
      title,
      updatedAt: at,
      workspaceId: member.workspaceId,
    };
  };

  const createDocument = async (
    principal: Principal,
    input: { title: string; markdown?: string },
    convertedFromId?: string
  ): Promise<LivePublishResult> => {
    const member = memberOf(principal);
    if (readOnly(member)) {
      throw new ForbiddenError("liveArtifacts.create");
    }
    if (!input.title.trim() || input.title.length > 120) {
      throw invalid("Title must be 1 to 120 characters");
    }
    const context = member.kind === "run" ? await runContext(member) : null;
    if (context?.run.scopeArtifactId) {
      throw new ForbiddenError("liveArtifacts.scope");
    }
    let source: Row | null = null;
    if (convertedFromId) {
      source = (await access(member, convertedFromId, true, false, false)).row;
      if (source.kind !== "doc") {
        throw invalid("Only static docs can be converted");
      }
    }
    const snapshot = await content.importMarkdown(input.markdown ?? "");
    const row = documentRow(member, input.title, context, source);
    return await persist(member, row, snapshot, true);
  };

  const shared = { ...deps, access, authorOf, event, now, participantId };
  return {
    ...createCommentsModule(shared),
    ...createChangesModule(shared),
    ...createAccessLifecycle(shared),
    /** L.3/L.7 must call after signature verification and before jti consumption,
     * and on renewal. Principal is freshly authenticated by trusted composition. */
    async admit(
      principal: Principal,
      input: { artifactId: string; ticket: string }
    ) {
      const member = memberOf(principal);
      const claims = await verifyRoomTicket(input.ticket, deps.ticketKey, {
        artifactId: input.artifactId,
        nowSeconds: Math.floor(clock.now().getTime() / 1000),
        workspaceId: member.workspaceId,
      });
      if (!claims || claims.participantId !== participantId(member)) {
        throw new ForbiddenError("liveArtifacts.admission");
      }
      const { role } = await access(principal, input.artifactId);
      if (role !== claims.role) {
        throw new ForbiddenError("liveArtifacts.staleTicket");
      }
      return claims;
    },
    async checkpoint(
      principal: Principal,
      input: DocumentSnapshot & { artifactId: string }
    ) {
      const { member, row } = await access(principal, input.artifactId, true);
      checkSnapshot(input);
      if (member.kind === "run") {
        await deps.anchors.guardAgentSnapshot(
          { artifactId: row.id, workspaceId: row.workspaceId },
          { runId: member.runId, snapshot: input }
        );
      }
      return await persist(member, row, input);
    },
    async convertDoc(
      principal: Principal,
      input: { artifactId: string; title?: string }
    ) {
      const { row } = await access(
        principal,
        input.artifactId,
        true,
        false,
        false
      );
      if (row.kind !== "doc") {
        throw invalid("Only static docs can be converted");
      }
      const source = await deps.artifacts.readFile(principal, {
        artifactId: row.id,
      });
      return await createDocument(
        principal,
        { markdown: source.text, title: input.title ?? row.title },
        row.id
      );
    },
    createDocument: (
      principal: Principal,
      input: { title: string; markdown?: string }
    ) => createDocument(principal, input),
    async join(
      principal: Principal,
      input: { artifactId: string }
    ): Promise<LiveJoinResult> {
      const { member, row, role } = await access(principal, input.artifactId);
      const identity = await deps.identity(member);
      const participant = {
        ...identity,
        id: participantId(member),
        kind: member.kind === "user" ? ("member" as const) : ("agent" as const),
      };
      const issuedAt = Math.floor(clock.now().getTime() / 1000);
      const ticket = await signRoomTicket(
        {
          ...identity,
          artifactId: row.id,
          audience: "artifact-room",
          connectionExpiresAt: issuedAt + ROOM_CONNECTION_MINUTES * 60,
          expiresAt: issuedAt + ROOM_TICKET_SECONDS,
          issuedAt,
          jti: crypto.randomUUID(),
          kind: participant.kind,
          participantId: participant.id,
          role,
          version: 1,
          workspaceId: row.workspaceId,
        },
        deps.ticketKey
      );
      return {
        participant,
        role,
        roomUrl: rooms.url({
          artifactId: row.id,
          workspaceId: row.workspaceId,
        }),
        ticket,
      };
    },
    async restore(
      principal: Principal,
      input: { artifactId: string; version: number }
    ) {
      const { member, row } = await access(
        principal,
        input.artifactId,
        true,
        true
      );
      const version = await findVersionByNumber(
        db,
        row.workspaceId,
        row.id,
        input.version
      );
      if (version?.status !== "published") {
        throw missing();
      }
      const file = (await versionFiles(db, row.workspaceId, version.id)).find(
        (candidate) => candidate.path === "state.ydoc"
      );
      const blob = file
        ? await blobs.get(blobKey(row.workspaceId, file.sha256))
        : null;
      if (!blob) {
        throw missing();
      }
      const snapshot = await content.loadDocument(blob.bytes);
      const restored = await rooms.restore(
        { artifactId: row.id, workspaceId: row.workspaceId },
        {
          byParticipant: participantId(member),
          snapshot,
          versionId: version.id,
        }
      );
      return await persist(member, row, restored, false, version.number);
    },
  };
};

export type LiveArtifactsService = ReturnType<
  typeof createLiveArtifactsService
>;
