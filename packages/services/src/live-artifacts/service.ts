import type { Database } from "@repo/db";
import {
  type findArtifact,
  findVersionById,
  findVersionByNumber,
  versionFiles,
} from "@repo/db/artifacts";
import type { Atomic, Statement } from "@repo/db/atomic";
import {
  artifacts,
  artifactVersionFiles,
  artifactVersions,
} from "@repo/db/schema/artifacts";
import {
  artifactCommentThreads,
  artifactLiveChanges,
} from "@repo/db/schema/live-artifacts";
import {
  ARTIFACT_FILE_MAX_BYTES,
  ARTIFACT_MAX_BYTES,
  ARTIFACT_MAX_FILES,
  LIVE_DOC_MAX_BYTES,
  ROOM_CONNECTION_MINUTES,
  ROOM_TICKET_SECONDS,
} from "@repo/db/shared";
import { contentTypeForPath } from "@repo/protocol/artifacts";
import type { LiveJoinResult } from "@repo/protocol/live";
import {
  commentAnchorSchema,
  type LiveOperationOrigin,
} from "@repo/protocol/live";
import { and, asc, eq, gt, inArray, isNull, type SQL } from "drizzle-orm";
import { ulid } from "ulidx";
import {
  blobKey,
  createArtifactBlobWriter,
  manifestKey,
  rethrowArtifactQuotaError,
} from "../artifacts/blob-writer.ts";
import { defaultAudience } from "../artifacts/policy.ts";
import type { ArtifactsService, PublishResult } from "../artifacts/service.ts";
import { ForbiddenError } from "../authz.ts";
import { isUniqueViolation, ServiceError } from "../errors.ts";
import type { EventsService } from "../events.ts";
import type { LibraryBlobs } from "../library.ts";
import type { Clock } from "../runs/types.ts";
import type { Principal } from "../workspaces.ts";
import { createLiveAccess } from "./access.ts";
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
  createDeck?: (input: {
    title: string;
    slides?: string[];
  }) => Promise<DocumentSnapshot>;
  exportDeck?: (
    snapshot: DocumentSnapshot,
    scope: LiveRoomScope
  ) => Promise<{
    markdown: string;
    html: string;
    files: Array<{ path: string; bytes: Uint8Array }>;
  }>;
  exportDocument: (
    snapshot: DocumentSnapshot,
    scope?: LiveRoomScope
  ) => Promise<{ markdown: string; html: string }>;
  importMarkdown: (markdown: string) => Promise<DocumentSnapshot>;
  loadDeck?: (
    state: Uint8Array,
    scope: LiveRoomScope
  ) => Promise<DocumentSnapshot>;
  /** Validate/sanitize stored state before applying a restore. */
  loadDocument: (
    state: Uint8Array,
    scope?: LiveRoomScope
  ) => Promise<DocumentSnapshot>;
}

export interface LiveRoomScope {
  artifactId: string;
  workspaceId: string;
}

/** Restore must apply state as one live change and return its new, monotonic revision. */
export interface LiveRoomsPort {
  agentChanges?: (scope: LiveRoomScope) => Promise<
    Array<{
      id: string;
      name: string;
      start: import("@repo/protocol/live").RelativePositionJSON;
      end: import("@repo/protocol/live").RelativePositionJSON;
      text: string;
    }>
  >;
  checkpointCanonical?: (
    scope: LiveRoomScope,
    input: DocumentSnapshot & { principal: Principal }
  ) => Promise<{ versionId: string; revision: number }>;
  checkpointIfDue?: (scope: LiveRoomScope) => Promise<void>;
  /** Recheck current DB access for one participant, or every connection if omitted. */
  refresh: (
    scope: LiveRoomScope,
    participantId?: string,
    mutationId?: string
  ) => Promise<void>;
  registerImage?: (scope: LiveRoomScope, fileId: string) => Promise<void>;
  restore: (
    scope: LiveRoomScope,
    input: {
      principal?: Principal;
      requestId?: string;
      snapshot: DocumentSnapshot;
      versionId: string;
      byParticipant: string;
    }
  ) => Promise<DocumentSnapshot>;
  saveRestored?: (
    scope: LiveRoomScope
  ) => Promise<{ versionId: string; revision: number }>;
  snapshot?: (scope: LiveRoomScope) => Promise<DocumentSnapshot>;
  suspend?: (scope: LiveRoomScope, mutationId: string) => Promise<void>;
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
  files?: Pick<import("../files.ts").FilesService, "upload">;
  identity: (
    principal: Extract<Principal, { kind: "user" | "run" }>
  ) => Promise<{ name: string; color: string }>;
  rooms: LiveRoomsPort;
  ticketKey: string;
}

export type Member = Extract<Principal, { kind: "user" | "run" }>;
export type Row = NonNullable<Awaited<ReturnType<typeof findArtifact>>>;
const IMAGE_FILE_PATH = /^\/files\/[A-Za-z0-9_-]+$/;
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

const imageMime = async (body: Blob) => {
  const head = new Uint8Array(await body.slice(0, 32).arrayBuffer());
  const ascii = new TextDecoder().decode(head);
  let mime: string | null = null;
  if (
    head[0] === 137 &&
    ascii.slice(1, 4) === "PNG" &&
    head[4] === 13 &&
    head[5] === 10 &&
    head[6] === 26 &&
    head[7] === 10
  ) {
    mime = "image/png";
  }
  if (head[0] === 255 && head[1] === 216 && head[2] === 255) {
    mime = "image/jpeg";
  }
  if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) {
    mime = "image/gif";
  }
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") {
    mime = "image/webp";
  }
  if (
    ascii.slice(4, 8) === "ftyp" &&
    ["avif", "avis"].includes(ascii.slice(8, 12))
  ) {
    mime = "image/avif";
  }
  if (!mime) {
    throw invalid("Upload a PNG, JPEG, GIF, WebP or AVIF image");
  }
  return mime;
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
  const { access, memberOf, runContext } = createLiveAccess(deps);
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

  const existingCheckpoint = async (
    row: Row,
    snapshot: DocumentSnapshot,
    versionId: string
  ) => {
    const prior = await findVersionById(db, row.workspaceId, versionId);
    if (!prior) {
      return null;
    }
    if (
      prior.artifactId !== row.id ||
      prior.message !== `Live checkpoint revision ${snapshot.revision}`
    ) {
      throw invalid("Checkpoint ID collision");
    }
    const file = (await versionFiles(db, row.workspaceId, prior.id)).find(
      (f) => f.path === "state.ydoc"
    );
    const blob = file
      ? await blobs.get(blobKey(row.workspaceId, file.sha256))
      : null;
    if (
      !blob ||
      blob.bytes.length !== snapshot.state.length ||
      !blob.bytes.every((b, i) => b === snapshot.state[i])
    ) {
      throw invalid("Checkpoint state collision");
    }
    return {
      artifactId: row.id,
      bytes: prior.totalBytes,
      files: prior.fileCount,
      revision: snapshot.revision,
      version: prior.number,
      versionId: prior.id,
    };
  };
  const creationStatements = (
    member: Member,
    row: Row,
    payload: Record<string, unknown>,
    initial: boolean
  ) =>
    initial
      ? [
          db.insert(artifacts).values(row),
          event(member, row, "artifact.created", payload),
        ]
      : [];
  const restoredStatements = (
    member: Member,
    row: Row,
    payload: Record<string, unknown>,
    from: number | undefined
  ) =>
    from === undefined
      ? []
      : [
          event(member, row, "artifact.restored", {
            ...payload,
            fromVersion: from,
          }),
        ];
  const checkpointImages = async (
    row: Row,
    html: string,
    baseBytes: number
  ) => {
    const urls = [
      ...new Set(
        [...html.matchAll(/src="(\/files\/[A-Za-z0-9_-]+)"/g)].flatMap(
          (match) => (typeof match[1] === "string" ? [match[1]] : [])
        )
      ),
    ];
    if (!urls.length) {
      return { files: [] as Array<{ path: string; bytes: Uint8Array }>, html };
    }
    if (urls.length + 3 > ARTIFACT_MAX_FILES) {
      throw invalid("Checkpoint has too many image files");
    }
    const { files: fileRows } = await import("@repo/db/schema/files");
    const rows = await Promise.all(
      urls.map(async (url) => {
        const [file] = await db
          .select()
          .from(fileRows)
          .where(
            and(
              eq(fileRows.id, url.slice(7)),
              eq(fileRows.workspaceId, row.workspaceId)
            )
          )
          .limit(1);
        if (!file) {
          throw missing();
        }
        return file;
      })
    );
    if (
      rows.reduce((total, file) => total + file.size, baseBytes) >
      ARTIFACT_MAX_BYTES
    ) {
      throw invalid("Checkpoint exceeds artifact file limits");
    }
    const suffixes: Record<string, string> = {
      "image/avif": "avif",
      "image/gif": "gif",
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
    };
    const files = await Promise.all(
      rows.map(async (file) => {
        const suffix = suffixes[file.mime];
        if (!suffix) {
          throw invalid("Invalid checkpoint image");
        }
        const blob = await blobs.get(file.r2Key);
        if (!blob || blob.bytes.length !== file.size) {
          throw missing();
        }
        return {
          bytes: blob.bytes,
          path: `images/${file.id}.${suffix}`,
          url: `/files/${file.id}`,
        };
      })
    );
    let renderedHtml = html;
    for (const file of files) {
      renderedHtml = renderedHtml.replaceAll(
        `src="${file.url}"`,
        `src="${file.path}"`
      );
    }
    return { files, html: renderedHtml };
  };
  const checkpointFiles = async (row: Row, snapshot: DocumentSnapshot) => {
    const exportContent =
      row.kind === "deck" ? content.exportDeck : content.exportDocument;
    if (!exportContent) {
      throw invalid("Deck content is unavailable");
    }
    const rendered = await exportContent(snapshot, {
      artifactId: row.id,
      workspaceId: row.workspaceId,
    });
    const encoder = new TextEncoder();
    const images = await checkpointImages(
      row,
      rendered.html,
      snapshot.state.byteLength +
        encoder.encode(rendered.markdown).length +
        encoder.encode(rendered.html).length
    );
    return [
      { bytes: new Uint8Array(snapshot.state), path: "state.ydoc" },
      { bytes: encoder.encode(rendered.markdown), path: "index.md" },
      { bytes: encoder.encode(images.html), path: "index.html" },
      ...images.files,
      ...("files" in rendered
        ? (rendered.files as Array<{ path: string; bytes: Uint8Array }>)
        : []),
    ];
  };
  const persist = async (
    member: Member,
    row: Row,
    snapshot: DocumentSnapshot,
    initial = false,
    restoredFrom?: number,
    checkpoint?: {
      checkpointId: string;
      restores: Array<{
        requestId: string;
        versionId: string;
        byParticipant: string;
      }>;
      origins: Array<
        LiveOperationOrigin & {
          summary: string;
          revFrom: number;
          revTo: number;
        }
      >;
    }
  ): Promise<LivePublishResult> => {
    checkSnapshot(snapshot);
    if (checkpoint) {
      const existing = await existingCheckpoint(
        row,
        snapshot,
        checkpoint.checkpointId
      );
      if (existing) {
        return existing;
      }
    }
    const number = await nextVersion(row, snapshot.revision, initial);
    const raw = await checkpointFiles(row, snapshot);
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
          ...new Uint8Array(
            await crypto.subtle.digest("SHA-256", new Uint8Array(file.bytes))
          ),
        ]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join(""),
      }))
    );
    const fresh = await checkQuota(row.workspaceId, files);
    const versionId = checkpoint ? checkpoint.checkpointId : ulid();
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
      ...creationStatements(member, row, payload, initial),
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
      ...restoredStatements(member, row, payload, restoredFrom),
      event(member, row, "artifact.live_checkpoint", payload),
      event(member, row, "artifact.published", payload),
      ...(checkpoint
        ? checkpoint.origins.map((origin) =>
            db
              .insert(artifactLiveChanges)
              .values({
                artifactId: row.id,
                createdAt: now(),
                id: origin.changeId,
                revFrom: origin.revFrom,
                revTo: origin.revTo,
                runId: origin.runId,
                summary: origin.summary,
                toolCallId: origin.toolCallId,
                workspaceId: row.workspaceId,
              })
              .onConflictDoNothing()
          )
        : []),
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
    async createDeck(
      principal: Principal,
      input: { title: string; slides?: string[] }
    ) {
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
      if (!content.createDeck) {
        throw invalid("Deck content is unavailable");
      }
      const snapshot = await content.createDeck(input);
      const row = {
        ...documentRow(member, input.title, context, null),
        kind: "deck" as const,
      };
      return persist(member, row, snapshot, true);
    },
    async durableCheckpoint(
      principal: Principal,
      input: DocumentSnapshot &
        LiveRoomScope & {
          checkpointId: string;
          restores: Array<{
            requestId: string;
            versionId: string;
            byParticipant: string;
          }>;
          origins: Array<
            LiveOperationOrigin & {
              summary: string;
              revFrom: number;
              revTo: number;
            }
          >;
        }
    ) {
      const { member, row } = await access(principal, input.artifactId, true);
      if (row.workspaceId !== input.workspaceId) {
        throw missing();
      }
      if (
        row.currentVersionId &&
        row.liveRoomRev === input.revision &&
        !input.restores.length &&
        !input.origins.length
      ) {
        const existing = await existingCheckpoint(
          row,
          input,
          row.currentVersionId
        );
        if (existing) {
          return existing;
        }
      }
      // Restore provenance belongs to the authenticated original actor, and its
      // source must belong to this artifact. Keep it in the same publication commit.
      const restored = input.restores.at(-1);
      let from: number | undefined;
      if (restored) {
        if (restored.byParticipant !== participantId(member)) {
          throw new ForbiddenError("liveArtifacts.restoreActor");
        }
        const source = await findVersionById(
          db,
          row.workspaceId,
          restored.versionId
        );
        if (!source || source.artifactId !== row.id) {
          throw missing();
        }
        from = source.number;
      }
      return persist(member, row, input, false, from, input);
    },
    async exportMarkdown(principal: Principal, input: { artifactId: string }) {
      const { row } = await access(principal, input.artifactId);
      if (!row.currentVersionId) {
        throw missing();
      }
      const file = (
        await versionFiles(db, row.workspaceId, row.currentVersionId)
      ).find((f) => f.path === "index.md");
      const blob = file
        ? await blobs.get(blobKey(row.workspaceId, file.sha256))
        : null;
      if (!blob) {
        throw missing();
      }
      return {
        markdown: new TextDecoder().decode(blob.bytes),
        revision: row.liveRoomRev ?? 0,
      };
    },
    async history(principal: Principal, input: { artifactId: string }) {
      const { row } = await access(principal, input.artifactId);
      return db
        .select({
          authorId: artifactVersions.authorId,
          authorKind: artifactVersions.authorKind,
          createdAt: artifactVersions.createdAt,
          id: artifactVersions.id,
          message: artifactVersions.message,
          number: artifactVersions.number,
        })
        .from(artifactVersions)
        .where(
          and(
            eq(artifactVersions.artifactId, row.id),
            eq(artifactVersions.workspaceId, row.workspaceId),
            eq(artifactVersions.status, "published")
          )
        )
        .orderBy(asc(artifactVersions.number));
    },
    async open(principal: Principal, input: { artifactId: string }) {
      const { row, role } = await access(principal, input.artifactId);
      if (!rooms.snapshot) {
        throw invalid("Room snapshots unavailable");
      }
      const snapshot = await rooms.snapshot({
        artifactId: row.id,
        workspaceId: row.workspaceId,
      });
      return {
        artifactId: row.id,
        kind: row.kind,
        revision: snapshot.revision,
        role,
        state: [...snapshot.state],
        title: row.title,
      };
    },
    async ownBlobUrls(principal: Principal, input: { artifactId: string }) {
      const { row } = await access(principal, input.artifactId);
      const manifest = await blobs.get(
        `${row.workspaceId}/live-artifacts/${row.id}/images.json`
      );
      return {
        urls: manifest
          ? (JSON.parse(new TextDecoder().decode(manifest.bytes)) as string[])
          : [],
      };
    },
    async policy(principal: Principal, input: { artifactId: string }) {
      const { row } = await access(principal, input.artifactId);
      const manifest = await blobs.get(
        `${row.workspaceId}/live-artifacts/${row.id}/images.json`
      );
      const ownBlobUrls: string[] = manifest
        ? JSON.parse(new TextDecoder().decode(manifest.bytes))
        : [];
      const agentChanges = rooms.agentChanges
        ? await rooms.agentChanges({
            artifactId: row.id,
            workspaceId: row.workspaceId,
          })
        : [];
      return { agentChanges, ownBlobUrls };
    },
    /** Revalidate a trusted in-process caller, never a ticket-derived identity. */
    async refreshTrustedPrincipal(principal: Principal) {
      const member = memberOf(principal);
      if (member.kind === "run") {
        const { run } = await runContext(member);
        if (
          !(["running", "waiting"].includes(run.status) && run.leaseUntil) ||
          run.leaseUntil <= now()
        ) {
          throw new ForbiddenError("liveArtifacts.runEnded");
        }
        return { ...member, dryRun: run.dryRun };
      }
      if (member.apiKey) {
        const { apiKeys } = await import("@repo/db/schema/api-keys");
        const [key] = await db
          .select()
          .from(apiKeys)
          .where(
            and(
              eq(apiKeys.id, member.apiKey.id),
              eq(apiKeys.workspaceId, member.workspaceId),
              eq(apiKeys.createdBy, member.userId),
              isNull(apiKeys.revokedAt)
            )
          )
          .limit(1);
        if (!key) {
          throw new ForbiddenError("liveArtifacts.revokedCredential");
        }
        return {
          ...member,
          apiKey: { access: key.access, id: key.id },
          isAdmin: false,
        };
      }
      // OAuth tokens must be reverified by the request/reference resolver, which
      // has the original token and its expiry. A bare principal is insufficient.
      if (member.oauthClient) {
        throw new ForbiddenError("liveArtifacts.credentialRequired");
      }
      return member;
    },
    async retryCheckpoints(
      principal: Principal,
      input: { cursor?: string; limit?: number } = {}
    ) {
      if (principal.kind !== "system") {
        throw new ForbiddenError("liveArtifacts.checkpointTick");
      }
      const limit = Math.min(100, Math.max(1, input.limit ?? 100));
      const rows = await db
        .select({
          artifactId: artifacts.id,
          workspaceId: artifacts.workspaceId,
        })
        .from(artifacts)
        .where(
          and(
            inArray(artifacts.kind, ["document", "deck"]),
            isNull(artifacts.deletedAt),
            input.cursor ? gt(artifacts.id, input.cursor) : undefined
          )
        )
        .orderBy(asc(artifacts.id))
        .limit(limit + 1);
      let completed = 0;
      for (const scope of rows.slice(0, limit)) {
        try {
          // biome-ignore lint/performance/noAwaitInLoops: bound memory and isolate failed room retries.
          await rooms.checkpointIfDue?.(scope);
          completed += 1;
        } catch {
          /* Each room retains its pending checkpoint for the next attempt. */
        }
      }
      return {
        attempted: Math.min(rows.length, limit),
        completed,
        ...(rows.length > limit ? { next: rows[limit - 1]?.artifactId } : {}),
      };
    },
    async roomIdentity(principal: Principal, artifactId: string) {
      const { member, role } = await access(principal, artifactId);
      return {
        ...(await deps.identity(member)),
        kind: member.kind === "user" ? ("member" as const) : ("agent" as const),
        participantId: participantId(member),
        role,
      };
    },
    /** Private production room adapter. Never mounted in a public router. */
    async roomOpen(principal: Principal, scope: LiveRoomScope) {
      if (principal.kind !== "system") {
        throw new ForbiddenError("liveArtifacts.roomOpen");
      }
      const [row] = await db
        .select()
        .from(artifacts)
        .where(
          and(
            eq(artifacts.id, scope.artifactId),
            eq(artifacts.workspaceId, scope.workspaceId)
          )
        )
        .limit(1);
      if (
        !(
          row &&
          ["document", "deck"].includes(row.kind) &&
          row.currentVersionId
        )
      ) {
        throw missing();
      }
      const version = await findVersionById(
        db,
        scope.workspaceId,
        row.currentVersionId
      );
      if (!version || version.artifactId !== row.id) {
        throw missing();
      }
      const file = (await versionFiles(db, scope.workspaceId, version.id)).find(
        (f) => f.path === "state.ydoc"
      );
      const blob = file
        ? await blobs.get(blobKey(scope.workspaceId, file.sha256))
        : null;
      if (!blob) {
        throw missing();
      }
      return {
        ...scope,
        kind: row.kind as "document" | "deck",
        revision: row.liveRoomRev ?? 0,
        state: blob.bytes,
      };
    },
    async roomOrgId(principal: Principal, workspaceId: string) {
      if (principal.kind !== "system") {
        throw new ForbiddenError("liveArtifacts.roomWorkspace");
      }
      const { workspaces } = await import("@repo/db/schema/workspaces");
      const [workspace] = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);
      return workspace?.clerkOrgId ?? null;
    },
    async roomPolicy(principal: Principal, scope: LiveRoomScope) {
      if (principal.kind !== "system") {
        throw new ForbiddenError("liveArtifacts.roomPolicy");
      }
      const rows = await db
        .select()
        .from(artifactCommentThreads)
        .where(
          and(
            eq(artifactCommentThreads.workspaceId, scope.workspaceId),
            eq(artifactCommentThreads.artifactId, scope.artifactId),
            isNull(artifactCommentThreads.resolvedAt)
          )
        );
      const ranges = rows.flatMap((row) => {
        const anchor = row.anchor
          ? commentAnchorSchema.safeParse(JSON.parse(row.anchor))
          : null;
        return anchor?.success &&
          anchor.data.kind === "document" &&
          !anchor.data.detached
          ? [{ end: anchor.data.end, start: anchor.data.start }]
          : [];
      });
      const manifest = await blobs.get(
        `${scope.workspaceId}/live-artifacts/${scope.artifactId}/images.json`
      );
      const urls: string[] = manifest
        ? JSON.parse(new TextDecoder().decode(manifest.bytes))
        : [];
      if (
        !Array.isArray(urls) ||
        urls.some(
          (url) => typeof url !== "string" || !IMAGE_FILE_PATH.test(url)
        )
      ) {
        throw invalid("Invalid image manifest");
      }
      return { ownBlobUrls: urls, ranges };
    },
    async roomRegisterImage(
      principal: Principal,
      scope: LiveRoomScope,
      fileId: string
    ) {
      if (principal.kind !== "system") {
        throw new ForbiddenError("liveArtifacts.registerImage");
      }
      const { files: fileRows } = await import("@repo/db/schema/files");
      const [file] = await db
        .select()
        .from(fileRows)
        .where(
          and(
            eq(fileRows.id, fileId),
            eq(fileRows.workspaceId, scope.workspaceId)
          )
        )
        .limit(1);
      if (
        !(
          file &&
          [
            "image/png",
            "image/jpeg",
            "image/gif",
            "image/webp",
            "image/avif",
          ].includes(file.mime)
        )
      ) {
        throw invalid("Image not found");
      }
      const key = `${scope.workspaceId}/live-artifacts/${scope.artifactId}/images.json`;
      const prior = await blobs.get(key);
      const urls: string[] = prior
        ? JSON.parse(new TextDecoder().decode(prior.bytes))
        : [];
      await blobs.put(
        key,
        new TextEncoder().encode(
          JSON.stringify([...new Set([...urls, `/files/${fileId}`])])
        )
      );
    },
    async uploadImage(
      principal: Principal,
      input: { artifactId: string; body: Blob; name: string }
    ) {
      const { row } = await access(principal, input.artifactId, true);
      if (!(deps.files && rooms.registerImage)) {
        throw invalid("Image storage is unavailable");
      }
      if (input.body.size > 8 * 1024 * 1024 || input.body.size < 12) {
        throw invalid("Images must be between 12 bytes and 8 MiB");
      }
      const mime = await imageMime(input.body);
      const file = await deps.files.upload(principal, {
        body: input.body,
        mime,
        name: input.name,
      });
      await rooms.registerImage(
        { artifactId: row.id, workspaceId: row.workspaceId },
        file.id
      );
      return { url: `/files/${file.id}` };
    },
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
      if (rooms.checkpointCanonical) {
        const result = await rooms.checkpointCanonical(
          { artifactId: row.id, workspaceId: row.workspaceId },
          { ...input, principal: member }
        );
        const saved = await findVersionById(
          db,
          row.workspaceId,
          result.versionId
        );
        if (!saved || saved.artifactId !== row.id) {
          throw missing();
        }
        return {
          artifactId: row.id,
          bytes: saved.totalBytes,
          files: saved.fileCount,
          revision: result.revision,
          version: saved.number,
          versionId: saved.id,
        };
      }
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
      input: { artifactId: string; version: number; requestId?: string }
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
      if (version === null) {
        throw missing();
      }
      if (version.status !== "published") {
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
      const loadContent =
        row.kind === "deck" ? content.loadDeck : content.loadDocument;
      if (!loadContent) {
        throw invalid("Deck content is unavailable");
      }
      const snapshot = await loadContent(blob.bytes, {
        artifactId: row.id,
        workspaceId: row.workspaceId,
      });
      const restored = await rooms.restore(
        { artifactId: row.id, workspaceId: row.workspaceId },
        {
          byParticipant: participantId(member),
          principal: member,
          requestId: input.requestId,
          snapshot,
          versionId: version.id,
        }
      );
      if (rooms.saveRestored) {
        const published = await rooms.saveRestored({
          artifactId: row.id,
          workspaceId: row.workspaceId,
        });
        const saved = await findVersionById(
          db,
          row.workspaceId,
          published.versionId
        );
        if (!saved || saved.artifactId !== row.id) {
          throw missing();
        }
        return {
          artifactId: row.id,
          bytes: saved.totalBytes,
          files: saved.fileCount,
          revision: published.revision,
          version: saved.number,
          versionId: saved.id,
        };
      }
      return await persist(member, row, restored, false, version.number);
    },
  };
};

export type LiveArtifactsService = ReturnType<
  typeof createLiveArtifactsService
>;
