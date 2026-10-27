/**
 * Artifacts core service (A.2, PRD sections 1 and 2): create, update, list,
 * read, restore, rename, audience and soft delete, with versions, content
 * addressed blobs, limits, the workspace quota and the events of R1.34.
 * Every method takes the calling principal and authorizes first.
 */

import type { Database } from "@repo/db";
import {
  type ArtifactRow,
  type ArtifactVersionRow,
  type ArtifactVisibility,
  activeLinkCounts,
  filesByVersionIds,
  findArtifact,
  findVersionById,
  findVersionByNumber,
  knownBlobSizes,
  listArtifacts,
  listVersions,
  maxVersionNumber,
  pinnedArtifactIds,
  versionFiles,
  versionsByIds,
  workspaceBlobBytes,
} from "@repo/db/artifacts";
import type { Atomic, Statement } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import {
  artifacts,
  artifactVersionFiles,
  artifactVersions,
} from "@repo/db/schema/artifacts";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { workspaces } from "@repo/db/schema/workspaces";
import {
  ARTIFACT_FILE_MAX_BYTES,
  ARTIFACT_MAX_BYTES,
  ARTIFACT_MAX_FILES,
  ARTIFACT_WORKSPACE_MAX_BYTES,
  type ArtifactAudience,
  type ArtifactKind,
  type ArtifactPublishedPayload,
  type EventType,
} from "@repo/db/shared";
import {
  type ArtifactCard,
  type ArtifactDetail,
  type ArtifactManifest,
  type ArtifactVersion,
  artifactManifestSchema,
  artifactPathSchema,
  contentTypeForPath,
} from "@repo/protocol/artifacts";
import { and, eq, inArray } from "drizzle-orm";
import { zipSync } from "fflate";
import { ulid } from "ulidx";
import { authorize, ForbiddenError } from "../authz.ts";
import { isUniqueViolation, ServiceError } from "../errors.ts";
import type { EventsService, PeopleLookup } from "../events.ts";
import { normalizePath } from "../library/path.ts";
import type { LibraryBlobs, LibraryService } from "../library.ts";
import type { Clock } from "../runs/types.ts";
import { visibleSessions } from "../sessions.ts";
import type { Principal } from "../workspaces.ts";
import type { ArtifactGrantsService } from "./grants.ts";
import { MANIFEST_PATH } from "./manifest.ts";
import {
  type ArtifactPolicyRecord,
  agentCanSee,
  agentCanUpdate,
  canManage,
  canOpen,
  defaultAudience,
} from "./policy.ts";

const ARTIFACT_RESOURCE = "artifact";
const TITLE_MAX = 120;
const TEXT_MAX = 500;
const PAGE_SIZE = 50;
const AGENT_LOOKUP_CHUNK = 80;
/** D1 binds at most 100 parameters per statement, and a file row binds 6. */
const FILE_ROWS_PER_INSERT = 10;
/** Blobs written at the same time. */
const BLOB_WRITE_PARALLEL = 8;
const CREATABLE_KINDS: readonly ArtifactKind[] = [
  "page",
  "doc",
  "dashboard",
  "app",
];
const TEXT_TYPE = /^(text\/|application\/(json|xml|javascript))|\+xml/;

type UserPrincipal = Extract<Principal, { kind: "user" }>;
type RunPrincipal = Extract<Principal, { kind: "run" }>;
type Member = UserPrincipal | RunPrincipal;

export interface ArtifactFileInput {
  base64?: string;
  path: string;
  text?: string;
}

/** Exactly one of `files` and `fromLibraryPath`. */
export interface ArtifactContentInput {
  /** Defaults to `index.md` for a doc, else `index.html`. */
  entry?: string;
  files?: ArtifactFileInput[];
  fromLibraryPath?: string;
}

export interface CreateArtifactInput extends ArtifactContentInput {
  description?: string;
  kind: "page" | "doc" | "dashboard" | "app";
  message?: string;
  title: string;
  /** The tool call that made it, carried on `artifact.published`. */
  toolCallId?: string;
}

export interface UpdateArtifactInput extends ArtifactContentInput {
  artifactId: string;
  baseVersion: number;
  message?: string;
  title?: string;
  toolCallId?: string;
}

export interface PublishResult {
  artifactId: string;
  bytes: number;
  files: number;
  version: number;
  versionId: string;
}

export interface ArtifactFileText {
  contentType: string;
  path: string;
  size: number;
  text: string;
  version: number;
}

export interface ArtifactListFilters {
  cursor?: string;
  kind?: ArtifactKind;
  madeBy?: "agent" | "person";
  /** Only artifacts with a version this run wrote. */
  runId?: string;
  shared?: boolean;
}

interface ResolvedFile {
  bytes: Uint8Array;
  contentType: string;
  path: string;
  sha256: string;
}

interface ResolvedContent {
  entry: string;
  files: ResolvedFile[];
  sourceLibraryPath: string | null;
}

/** Where a version came from and what it holds. Rows are the same for create, update and restore. */
interface VersionDraft {
  entry: string;
  files: { contentType: string; path: string; sha256: string; size: number }[];
  message: string;
  number: number;
  parentNumber: number | null;
  sourceLibraryPath: string | null;
  versionId: string;
}

const invalid = (message: string) => new ServiceError("invalid", message);
const hasUtf16Bom = (bytes: Uint8Array): boolean =>
  bytes.byteLength >= 2 &&
  ((bytes[0] === 0xff && bytes[1] === 0xfe) ||
    (bytes[0] === 0xfe && bytes[1] === 0xff));

/**
 * The content route reads HTML as UTF-8 to inject the bridge, and a browser
 * lets a UTF-16 byte order mark override the header, so such a page would run
 * without it.
 */
const checkEncoding = (file: { bytes: Uint8Array; path: string }): void => {
  if (
    contentTypeForPath(file.path).startsWith("text/html") &&
    hasUtf16Bom(file.bytes)
  ) {
    throw invalid(`${file.path} must be UTF-8, not UTF-16`);
  }
};

const notFound = () => new ServiceError("not_found", "Artifact not found");

const toHex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const sha256Of = async (bytes: Uint8Array): Promise<string> =>
  toHex(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));

const decodeBase64 = (value: string, path: string): Uint8Array => {
  if (Math.ceil((value.length * 3) / 4) > ARTIFACT_FILE_MAX_BYTES + 3) {
    throw invalid(`${path} is over ${ARTIFACT_FILE_MAX_BYTES} bytes`);
  }
  try {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  } catch {
    // biome-ignore lint/style/useErrorCause: the decoder error says nothing a caller can use
    throw invalid(`${path} is not valid base64`);
  }
};

const chunks = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
};

const blobKey = (workspaceId: string, sha256: string) =>
  `${workspaceId}/artifact-blobs/${sha256}`;
const thumbnailKey = (workspaceId: string, versionId: string) =>
  `${workspaceId}/artifact-thumbnails/${versionId}.png`;
const manifestKey = (workspaceId: string, versionId: string) =>
  `${workspaceId}/artifact-manifests/${versionId}.json`;

const checkText = (
  label: string,
  value: string | undefined,
  min: number,
  max: number
) => {
  if (value !== undefined && (value.length < min || value.length > max)) {
    throw invalid(
      min > 0
        ? `${label} must be ${min} to ${max} characters`
        : `${label} must be at most ${max} characters`
    );
  }
};

const policyRecord = (row: ArtifactRow): ArtifactPolicyRecord => ({
  agentId: row.agentId,
  audience: row.audience,
  handedToAgentId: row.handedToAgentId,
  ownerUserId: row.ownerUserId,
});

const toVersion = (row: ArtifactVersionRow): ArtifactVersion => ({
  authorId: row.authorId,
  authorKind: row.authorKind,
  authorRunId: row.authorRunId,
  createdAt: row.createdAt,
  entry: row.entry,
  fileCount: row.fileCount,
  hasThumbnail: row.thumbnailKey !== null,
  id: row.id,
  message: row.message,
  number: row.number,
  parentNumber: row.parentNumber,
  sourceLibraryPath: row.sourceLibraryPath,
  status: row.status,
  totalBytes: row.totalBytes,
});

const visibilityOf = (member: Member): ArtifactVisibility => {
  if (member.kind === "run") {
    return { agentId: member.agentId, kind: "agent" };
  }
  return member.isAdmin === true
    ? { kind: "admin" }
    : { kind: "member", userId: member.userId };
};

const encodeCursor = (row: ArtifactRow) => `${row.updatedAt}~${row.id}`;
const decodeCursor = (cursor: string): { id: string; updatedAt: string } => {
  const at = cursor.lastIndexOf("~");
  if (at <= 0 || at === cursor.length - 1) {
    throw invalid("Invalid cursor");
  }
  return { id: cursor.slice(at + 1), updatedAt: cursor.slice(0, at) };
};

export const createArtifactsService = ({
  atomic,
  blobs,
  clock,
  db,
  events,
  grants,
  library,
  people,
}: {
  atomic: Atomic;
  blobs: Pick<LibraryBlobs, "get" | "put">;
  clock: Clock;
  db: Database;
  events: Pick<EventsService, "insertStatement">;
  /** Checks and records the grants of an `app` version (B.4). Without it apps are refused. */
  grants?: Pick<ArtifactGrantsService, "checkManifest" | "recordVersionGrants">;
  library: Pick<LibraryService, "list" | "read">;
  /** Looks up owner names for cards. Without it, `ownerName` is null. */
  people?: PeopleLookup;
}) => {
  const nowIso = () => clock.now().toISOString();

  // Principals

  /** A user or a run. Machines, triggers and the tick have no artifacts. */
  const reader = (principal: Principal, action: string): Member => {
    if (principal.kind !== "user" && principal.kind !== "run") {
      throw new ForbiddenError(action);
    }
    authorize(principal, action, {
      kind: ARTIFACT_RESOURCE,
      workspaceId: principal.workspaceId,
    });
    return principal;
  };

  /** Writing: a read-only key or client and a dry run never write. */
  const writer = (principal: Principal, action: string): Member => {
    const member = reader(principal, action);
    if (
      member.kind === "run"
        ? member.dryRun === true
        : member.apiKey?.access === "read" ||
          member.oauthClient?.access === "read"
    ) {
      throw new ForbiddenError(action);
    }
    return member;
  };

  /** A person acting on an artifact: rename, restore, audience and delete are not for runs. */
  const person = (principal: Principal, action: string): UserPrincipal => {
    const member = writer(principal, action);
    if (member.kind !== "user") {
      throw new ForbiddenError(action);
    }
    return member;
  };

  const policyUser = (user: UserPrincipal) => ({
    isAdmin: user.isAdmin === true,
    userId: user.userId,
  });

  const canSee = (member: Member, row: ArtifactRow): boolean =>
    member.kind === "user"
      ? canOpen(policyRecord(row), policyUser(member))
      : agentCanSee(policyRecord(row), member.agentId);

  /** The artifact when the member may see it. A hidden one is not_found, never forbidden. */
  const visible = async (
    member: Member,
    artifactId: string
  ): Promise<ArtifactRow> => {
    const row = await findArtifact(db, member.workspaceId, artifactId);
    if (!(row && canSee(member, row))) {
      throw notFound();
    }
    return row;
  };

  const managed = async (
    user: UserPrincipal,
    artifactId: string,
    action: string
  ): Promise<ArtifactRow> => {
    const row = await visible(user, artifactId);
    if (!canManage(policyRecord(row), policyUser(user))) {
      throw new ForbiddenError(action);
    }
    return row;
  };

  const actorOf = (member: Member) =>
    member.kind === "user"
      ? ({ id: member.userId, kind: "user" } as const)
      : ({ id: member.agentId, kind: "agent" } as const);

  const event = (
    member: Member,
    type: EventType,
    payload: Record<string, unknown>,
    scope: { sessionId: string | null }
  ): Statement =>
    events.insertStatement({
      actor: actorOf(member),
      agentId: member.kind === "run" ? member.agentId : null,
      payload,
      runId: member.kind === "run" ? member.runId : null,
      sessionId: scope.sessionId,
      type,
      workspaceId: member.workspaceId,
    });

  // Content

  const walkLibrary = async (
    member: Member,
    folder: string
  ): Promise<{ path: string; size: number }[]> => {
    const found: { path: string; size: number }[] = [];
    const visit = async (dir: string) => {
      for (const entry of await library.list(member, dir)) {
        if (entry.kind === "dir") {
          // biome-ignore lint/performance/noAwaitInLoops: depth first keeps the file order and stops at the limit
          await visit(entry.path);
          continue;
        }
        found.push({ path: entry.path, size: entry.size });
        if (found.length > ARTIFACT_MAX_FILES) {
          throw invalid(
            `An artifact holds at most ${ARTIFACT_MAX_FILES} files`
          );
        }
      }
    };
    await visit(folder);
    return found;
  };

  const fromLibrary = async (
    member: Member,
    rawFolder: string
  ): Promise<{ files: Omit<ResolvedFile, "sha256">[]; folder: string }> => {
    const folder = normalizePath(rawFolder);
    if (folder === "") {
      throw invalid("fromLibraryPath must name a folder");
    }
    // The library refuses a folder outside the member's read scope with not_found.
    const listed = await walkLibrary(member, folder);
    // The listing carries sizes: refuse before reading any bytes into memory.
    if (listed.reduce((sum, item) => sum + item.size, 0) > ARTIFACT_MAX_BYTES) {
      throw invalid(`An artifact holds at most ${ARTIFACT_MAX_BYTES} bytes`);
    }
    const files: Omit<ResolvedFile, "sha256">[] = [];
    for (const item of listed) {
      if (item.size > ARTIFACT_FILE_MAX_BYTES) {
        throw invalid(`${item.path} is over ${ARTIFACT_FILE_MAX_BYTES} bytes`);
      }
      // biome-ignore lint/performance/noAwaitInLoops: at most 200 files, read one at a time
      const { bytes } = await library.read(member, item.path);
      const path = item.path.slice(folder.length + 1);
      files.push({ bytes, contentType: contentTypeForPath(path), path });
    }
    return { files, folder };
  };

  const fromInline = (
    input: ArtifactFileInput[]
  ): Omit<ResolvedFile, "sha256">[] => {
    if (input.length > ARTIFACT_MAX_FILES) {
      throw invalid(`An artifact holds at most ${ARTIFACT_MAX_FILES} files`);
    }
    const seen = new Set<string>();
    return input.map((file) => {
      const checked = artifactPathSchema.safeParse(file.path);
      if (!checked.success) {
        throw invalid(
          `${file.path}: ${checked.error.issues[0]?.message ?? "invalid path"}`
        );
      }
      if (seen.has(file.path)) {
        throw invalid(`${file.path} appears twice`);
      }
      seen.add(file.path);
      if ((file.text === undefined) === (file.base64 === undefined)) {
        throw invalid(`${file.path} needs exactly one of text and base64`);
      }
      const bytes =
        file.text === undefined
          ? decodeBase64(file.base64 ?? "", file.path)
          : new TextEncoder().encode(file.text);
      return {
        bytes,
        contentType: contentTypeForPath(file.path),
        path: file.path,
      };
    });
  };

  /** The files of an input, hashed and checked against R1.4 before any write. */
  const resolveContent = async (
    member: Member,
    input: ArtifactContentInput,
    kind: ArtifactKind
  ): Promise<ResolvedContent> => {
    if ((input.files === undefined) === (input.fromLibraryPath === undefined)) {
      throw invalid("Give exactly one of files and fromLibraryPath");
    }
    const entry = input.entry ?? (kind === "doc" ? "index.md" : "index.html");
    let raw: Omit<ResolvedFile, "sha256">[];
    let sourceLibraryPath: string | null = null;
    if (input.fromLibraryPath === undefined) {
      raw = fromInline(input.files ?? []);
    } else {
      const loaded = await fromLibrary(member, input.fromLibraryPath);
      raw = loaded.files;
      sourceLibraryPath = loaded.folder;
    }
    const entryChecked = artifactManifestSchema.shape.entry.safeParse(entry);
    if (!entryChecked.success) {
      throw invalid(
        `entry: ${entryChecked.error.issues[0]?.message ?? "invalid path"}`
      );
    }
    if (!raw.some((file) => file.path === entry)) {
      throw invalid(`The entry file ${entry} is missing`);
    }
    for (const file of raw) {
      const checked = artifactPathSchema.safeParse(file.path);
      if (!checked.success) {
        throw invalid(
          `${file.path}: ${checked.error.issues[0]?.message ?? "invalid path"}`
        );
      }
      if (file.bytes.byteLength > ARTIFACT_FILE_MAX_BYTES) {
        throw invalid(`${file.path} is over ${ARTIFACT_FILE_MAX_BYTES} bytes`);
      }
      checkEncoding(file);
    }
    const total = raw.reduce((sum, file) => sum + file.bytes.byteLength, 0);
    if (total > ARTIFACT_MAX_BYTES) {
      throw invalid(`An artifact holds at most ${ARTIFACT_MAX_BYTES} bytes`);
    }
    const files = await Promise.all(
      raw.map(async (file) => ({
        ...file,
        sha256: await sha256Of(file.bytes),
      }))
    );
    return { entry, files, sourceLibraryPath };
  };

  /** Refuses a write that would take the workspace's blobs over the quota. */
  const checkQuota = async (
    workspaceId: string,
    files: readonly ResolvedFile[]
  ): Promise<Set<string>> => {
    const unique = new Map<string, number>();
    for (const file of files) {
      unique.set(file.sha256, file.bytes.byteLength);
    }
    const known = await knownBlobSizes(db, workspaceId, [...unique.keys()]);
    const fresh = new Set<string>();
    let freshBytes = 0;
    for (const [hash, size] of unique) {
      if (!known.has(hash)) {
        fresh.add(hash);
        freshBytes += size;
      }
    }
    const used = await workspaceBlobBytes(db, workspaceId);
    if (used + freshBytes > ARTIFACT_WORKSPACE_MAX_BYTES) {
      throw invalid("The workspace's artifact storage is full (1 GB)");
    }
    return fresh;
  };

  const writeBlobs = async (
    workspaceId: string,
    files: readonly ResolvedFile[],
    fresh: ReadonlySet<string>
  ) => {
    const toWrite = new Map<string, Uint8Array>();
    for (const file of files) {
      if (fresh.has(file.sha256)) {
        toWrite.set(file.sha256, file.bytes);
      }
    }
    for (const batch of chunks([...toWrite], BLOB_WRITE_PARALLEL)) {
      // biome-ignore lint/performance/noAwaitInLoops: a few blobs at a time, not 200 at once
      await Promise.all(
        batch.map(([hash, bytes]) =>
          blobs.put(blobKey(workspaceId, hash), bytes)
        )
      );
    }
  };

  const writeManifest = async (workspaceId: string, draft: VersionDraft) => {
    const manifest: ArtifactManifest = {
      entry: draft.entry,
      files: Object.fromEntries(
        draft.files.map((file) => [
          file.path,
          {
            contentType: file.contentType,
            sha256: file.sha256,
            size: file.size,
          },
        ])
      ),
    };
    const checked = artifactManifestSchema.safeParse(manifest);
    if (!checked.success) {
      throw invalid(checked.error.issues[0]?.message ?? "Invalid artifact");
    }
    await blobs.put(
      manifestKey(workspaceId, draft.versionId),
      new TextEncoder().encode(JSON.stringify(checked.data))
    );
  };

  /** The paths of a stored version with the bytes of its manifest, for the grant check. */
  const manifestOf = async (
    member: Member,
    files: { path: string; sha256: string }[]
  ): Promise<ResolvedFile[]> =>
    await Promise.all(
      files.map(async (file) => {
        const blob =
          file.path === MANIFEST_PATH
            ? await blobs.get(blobKey(member.workspaceId, file.sha256))
            : null;
        return {
          bytes: blob?.bytes ?? new Uint8Array(),
          contentType: "",
          path: file.path,
          sha256: file.sha256,
        };
      })
    );

  /** An agent's app version waits `proposed` for `artifact_promote`; a person's goes live at once. */
  const statusFor = (member: Member, kind: ArtifactKind) =>
    kind === "app" && member.kind === "run" ? "proposed" : "published";

  const manifestFiles = (files: ResolvedFile[]) =>
    files.map((file) => ({
      path: file.path,
      ...(file.path === MANIFEST_PATH && {
        text: new TextDecoder().decode(file.bytes),
      }),
    }));

  /** Before an app version is written: its manifest must parse and ask only for read-only tools. */
  const checkApp = async (
    member: Member,
    kind: ArtifactKind,
    files: ResolvedFile[]
  ) => {
    if (kind !== "app") {
      return;
    }
    if (!grants) {
      throw invalid("Apps are not enabled");
    }
    await grants.checkManifest(member, manifestFiles(files));
  };

  /** After an app version is written: one grant row per ask. */
  const recordApp = async (
    member: Member,
    kind: ArtifactKind,
    ids: { artifactId: string; versionId: string },
    files: ResolvedFile[]
  ) => {
    if (kind === "app" && grants) {
      await grants.recordVersionGrants(member, {
        ...ids,
        files: manifestFiles(files),
      });
    }
  };

  /** The rows of a new version: the version and its files, in chunks D1 can bind. */
  const versionStatements = (
    member: Member,
    artifactId: string,
    draft: VersionDraft,
    status: "proposed" | "published" = "published"
  ): Statement[] => {
    const at = nowIso();
    const totalBytes = draft.files.reduce((sum, file) => sum + file.size, 0);
    const author = actorOf(member);
    return [
      db.insert(artifactVersions).values({
        artifactId,
        authorId: author.id,
        authorKind: author.kind,
        authorRunId: member.kind === "run" ? member.runId : null,
        createdAt: at,
        entry: draft.entry,
        fileCount: draft.files.length,
        id: draft.versionId,
        manifestKey: manifestKey(member.workspaceId, draft.versionId),
        message: draft.message,
        number: draft.number,
        parentNumber: draft.parentNumber,
        sourceLibraryPath: draft.sourceLibraryPath,
        status,
        totalBytes,
        workspaceId: member.workspaceId,
      }),
      ...chunks(draft.files, FILE_ROWS_PER_INSERT).map((part) =>
        db.insert(artifactVersionFiles).values(
          part.map((file) => ({
            contentType: file.contentType,
            path: file.path,
            sha256: file.sha256,
            size: file.size,
            versionId: draft.versionId,
            workspaceId: member.workspaceId,
          }))
        )
      ),
    ];
  };

  const publishedEvent = (
    member: Member,
    row: { id: string; kind: ArtifactKind; sessionId: string | null },
    title: string,
    draft: VersionDraft,
    toolCallId?: string
  ): Statement => {
    const payload: ArtifactPublishedPayload = {
      artifactId: row.id,
      kind: row.kind,
      runId: member.kind === "run" ? member.runId : null,
      sessionId: row.sessionId,
      title,
      version: draft.number,
      versionId: draft.versionId,
      ...(toolCallId === undefined ? {} : { toolCallId }),
    };
    return event(member, "artifact.published", { ...payload }, row);
  };

  /** A unique-index loss on `(artifact_id, number)` means a racing update won. */
  const commit = async (statements: Statement[], currentHint: string) => {
    try {
      await atomic(statements);
    } catch (error) {
      if (isUniqueViolation(error)) {
        // biome-ignore lint/style/useErrorCause: ServiceError takes a code and a message only
        throw new ServiceError(
          "conflict",
          `The artifact changed while you updated it. ${currentHint}`
        );
      }
      throw error;
    }
  };

  const resultOf = (
    artifactId: string,
    draft: VersionDraft
  ): PublishResult => ({
    artifactId,
    bytes: draft.files.reduce((sum, file) => sum + file.size, 0),
    files: draft.files.length,
    version: draft.number,
    versionId: draft.versionId,
  });

  const draftOf = (
    content: ResolvedContent,
    base: Pick<VersionDraft, "message" | "number" | "parentNumber">
  ): VersionDraft => ({
    ...base,
    entry: content.entry,
    files: content.files.map((file) => ({
      contentType: file.contentType,
      path: file.path,
      sha256: file.sha256,
      size: file.bytes.byteLength,
    })),
    sourceLibraryPath: content.sourceLibraryPath,
    versionId: ulid(),
  });

  // Where the run is: its owner and the session it publishes into.

  const runContext = async (run: RunPrincipal) => {
    const [row] = await db
      .select({
        onBehalfOfUserId: runs.onBehalfOfUserId,
        sessionId: runs.sessionId,
      })
      .from(runs)
      .where(and(eq(runs.id, run.runId), eq(runs.workspaceId, run.workspaceId)))
      .limit(1);
    if (!row) {
      throw new ServiceError("not_found", "Run not found");
    }
    const [session] = await db
      .select({ origin: sessions.origin, private: sessions.private })
      .from(sessions)
      .where(
        and(
          eq(sessions.id, row.sessionId),
          eq(sessions.workspaceId, run.workspaceId)
        )
      )
      .limit(1);
    return {
      ownerUserId: row.onBehalfOfUserId,
      session,
      sessionId: row.sessionId,
    };
  };

  // Writes

  const create = async (
    principal: Principal,
    input: CreateArtifactInput
  ): Promise<PublishResult> => {
    const member = writer(principal, "artifacts.create");
    checkText("title", input.title, 1, TITLE_MAX);
    checkText("description", input.description, 0, TEXT_MAX);
    checkText("message", input.message, 0, TEXT_MAX);
    if (!CREATABLE_KINDS.includes(input.kind)) {
      throw invalid(`Kind ${input.kind} cannot be created yet`);
    }
    const content = await resolveContent(member, input, input.kind);
    await checkApp(member, input.kind, content.files);
    const fresh = await checkQuota(member.workspaceId, content.files);

    const scope =
      member.kind === "run"
        ? await runContext(member)
        : { ownerUserId: member.userId, session: undefined, sessionId: null };
    const audience: ArtifactAudience = defaultAudience(scope.session ?? null);
    const artifactId = crypto.randomUUID();
    const at = nowIso();
    const draft = draftOf(content, {
      message: input.message ?? "",
      number: 1,
      parentNumber: null,
    });
    await writeBlobs(member.workspaceId, content.files, fresh);
    await writeManifest(member.workspaceId, draft);

    const author = actorOf(member);
    const row = {
      id: artifactId,
      kind: input.kind,
      sessionId: scope.sessionId,
    };
    await commit(
      [
        db.insert(artifacts).values({
          agentId: member.kind === "run" ? member.agentId : null,
          audience,
          createdAt: at,
          createdById: author.id,
          createdByKind: author.kind,
          currentVersionId:
            statusFor(member, input.kind) === "proposed"
              ? null
              : draft.versionId,
          description: input.description ?? null,
          id: artifactId,
          kind: input.kind,
          ownerUserId: scope.ownerUserId,
          runId: member.kind === "run" ? member.runId : null,
          sessionId: scope.sessionId,
          title: input.title,
          updatedAt: at,
          workspaceId: member.workspaceId,
        }),
        ...versionStatements(
          member,
          artifactId,
          draft,
          statusFor(member, input.kind)
        ),
        event(
          member,
          "artifact.created",
          { artifactId, audience, kind: input.kind, title: input.title },
          row
        ),
        publishedEvent(member, row, input.title, draft, input.toolCallId),
      ],
      ""
    );
    await recordApp(
      member,
      input.kind,
      { artifactId, versionId: draft.versionId },
      content.files
    );
    return resultOf(artifactId, draft);
  };

  const update = async (
    principal: Principal,
    input: UpdateArtifactInput
  ): Promise<PublishResult> => {
    const member = writer(principal, "artifacts.update");
    checkText("title", input.title, 1, TITLE_MAX);
    checkText("message", input.message, 0, TEXT_MAX);
    const row = await visible(member, input.artifactId);
    const allowed =
      member.kind === "run"
        ? agentCanUpdate(policyRecord(row), member.agentId)
        : canManage(policyRecord(row), policyUser(member));
    if (!allowed) {
      throw new ForbiddenError("artifacts.update");
    }
    const current = row.currentVersionId
      ? await findVersionById(db, member.workspaceId, row.currentVersionId)
      : null;
    // An app nobody promoted yet has no current version: it builds on its newest.
    const baseNumber =
      current?.number ??
      (row.kind === "app"
        ? await maxVersionNumber(db, member.workspaceId, row.id)
        : 0);
    if (baseNumber === 0) {
      throw notFound();
    }
    if (input.baseVersion !== baseNumber) {
      throw new ServiceError(
        "conflict",
        `Stale baseVersion ${input.baseVersion}: the current version is ${baseNumber}`
      );
    }
    // Read the number right after the stale check, before the slow work below,
    // so a racing update on the same base picks the same number and the unique
    // index refuses the second one.
    const number = (await maxVersionNumber(db, member.workspaceId, row.id)) + 1;
    const content = await resolveContent(member, input, row.kind);
    await checkApp(member, row.kind, content.files);
    const fresh = await checkQuota(member.workspaceId, content.files);
    const draft = draftOf(content, {
      message: input.message ?? "",
      number,
      parentNumber: baseNumber,
    });
    const status = statusFor(member, row.kind);
    await writeBlobs(member.workspaceId, content.files, fresh);
    await writeManifest(member.workspaceId, draft);
    const title = input.title ?? row.title;
    await commit(
      [
        ...versionStatements(member, row.id, draft, status),
        db
          .update(artifacts)
          .set({
            ...(status === "published" && {
              currentVersionId: draft.versionId,
              // The new version has no thumbnail until `artifact_test` makes one.
              thumbnailKey: null,
            }),
            title,
            updatedAt: nowIso(),
          })
          .where(
            and(
              eq(artifacts.id, row.id),
              eq(artifacts.workspaceId, member.workspaceId)
            )
          ),
        publishedEvent(member, row, title, draft, input.toolCallId),
      ],
      `The current version is ${number - 1}.`
    );
    await recordApp(
      member,
      row.kind,
      { artifactId: row.id, versionId: draft.versionId },
      content.files
    );
    return resultOf(row.id, draft);
  };

  const restore = async (
    principal: Principal,
    artifactId: string,
    versionNumber: number
  ): Promise<{ version: number }> => {
    const user = person(principal, "artifacts.restore");
    const row = await managed(user, artifactId, "artifacts.restore");
    const source = await findVersionByNumber(
      db,
      user.workspaceId,
      row.id,
      versionNumber
    );
    if (source?.status !== "published") {
      throw new ServiceError("not_found", "Version not found");
    }
    const current = row.currentVersionId
      ? await findVersionById(db, user.workspaceId, row.currentVersionId)
      : null;
    const files = await versionFiles(db, user.workspaceId, source.id);
    const number = (await maxVersionNumber(db, user.workspaceId, row.id)) + 1;
    const draft: VersionDraft = {
      entry: source.entry,
      files: files.map((file) => ({
        contentType: file.contentType,
        path: file.path,
        sha256: file.sha256,
        size: file.size,
      })),
      message: `Restored version ${source.number}`,
      number,
      parentNumber: current?.number ?? null,
      sourceLibraryPath: source.sourceLibraryPath,
      versionId: ulid(),
    };
    // An app's restored version asks for what the old one asked for, so its
    // manifest is checked again and its grants are recorded like a new version's.
    const appFiles = row.kind === "app" ? await manifestOf(user, files) : [];
    if (row.kind === "app") {
      await checkApp(user, row.kind, appFiles);
    }
    await writeManifest(user.workspaceId, draft);
    await commit(
      [
        ...versionStatements(user, row.id, draft),
        db
          .update(artifacts)
          .set({
            currentVersionId: draft.versionId,
            thumbnailKey: null,
            updatedAt: nowIso(),
          })
          .where(
            and(
              eq(artifacts.id, row.id),
              eq(artifacts.workspaceId, user.workspaceId)
            )
          ),
        event(
          user,
          "artifact.restored",
          { artifactId: row.id, fromVersion: source.number, version: number },
          row
        ),
        publishedEvent(user, row, row.title, draft),
      ],
      `The current version is ${number - 1}.`
    );
    await recordApp(
      user,
      row.kind,
      { artifactId: row.id, versionId: draft.versionId },
      appFiles
    );
    return { version: number };
  };

  const rename = async (
    principal: Principal,
    artifactId: string,
    title: string
  ): Promise<void> => {
    const user = person(principal, "artifacts.rename");
    checkText("title", title, 1, TITLE_MAX);
    const row = await managed(user, artifactId, "artifacts.rename");
    await atomic([
      db
        .update(artifacts)
        .set({ title, updatedAt: nowIso() })
        .where(
          and(
            eq(artifacts.id, row.id),
            eq(artifacts.workspaceId, user.workspaceId)
          )
        ),
      event(
        user,
        "artifact.renamed",
        { artifactId: row.id, from: row.title, to: title },
        { sessionId: null }
      ),
    ]);
  };

  const setAudience = async (
    principal: Principal,
    artifactId: string,
    audience: ArtifactAudience
  ): Promise<void> => {
    const user = person(principal, "artifacts.setAudience");
    const row = await managed(user, artifactId, "artifacts.setAudience");
    await atomic([
      db
        .update(artifacts)
        .set({ audience, updatedAt: nowIso() })
        .where(
          and(
            eq(artifacts.id, row.id),
            eq(artifacts.workspaceId, user.workspaceId)
          )
        ),
      event(
        user,
        "artifact.audience_changed",
        { artifactId: row.id, from: row.audience, to: audience },
        { sessionId: null }
      ),
    ]);
  };

  const remove = async (
    principal: Principal,
    artifactId: string
  ): Promise<void> => {
    const user = person(principal, "artifacts.remove");
    const row = await managed(user, artifactId, "artifacts.remove");
    const at = nowIso();
    await atomic([
      db
        .update(artifacts)
        .set({ deletedAt: at, deletedBy: user.userId, updatedAt: at })
        .where(
          and(
            eq(artifacts.id, row.id),
            eq(artifacts.workspaceId, user.workspaceId)
          )
        ),
      event(
        user,
        "artifact.deleted",
        { artifactId: row.id, title: row.title },
        { sessionId: null }
      ),
    ]);
  };

  // Reads

  const agentNames = async (
    workspaceId: string,
    ids: readonly string[]
  ): Promise<Map<string, string>> => {
    const names = new Map<string, string>();
    if (ids.length === 0) {
      return names;
    }
    const parts = await Promise.all(
      chunks([...new Set(ids)], AGENT_LOOKUP_CHUNK).map((part) =>
        db
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(
            and(eq(agents.workspaceId, workspaceId), inArray(agents.id, part))
          )
      )
    );
    for (const row of parts.flat()) {
      names.set(row.id, row.name);
    }
    return names;
  };

  const ownerNames = async (
    ids: readonly string[]
  ): Promise<Map<string, string>> => {
    const names = new Map<string, string>();
    if (!people || ids.length === 0) {
      return names;
    }
    try {
      const found = await people(ids);
      for (const [id, who] of found) {
        const label = who.name?.trim() || who.email?.trim();
        if (label) {
          names.set(id, label);
        }
      }
    } catch (error) {
      console.error("People lookup failed", error);
    }
    return names;
  };

  const cards = async (
    member: Member,
    rows: readonly ArtifactRow[]
  ): Promise<ArtifactCard[]> => {
    const ids = rows.map((row) => row.id);
    const [links, pinned, versionRows, agentLabel, ownerLabel] =
      await Promise.all([
        activeLinkCounts(db, member.workspaceId, ids, nowIso()),
        member.kind === "user"
          ? pinnedArtifactIds(db, member.workspaceId, member.userId, ids)
          : Promise.resolve(new Set<string>()),
        versionsByIds(
          db,
          member.workspaceId,
          rows.flatMap((row) =>
            row.currentVersionId ? [row.currentVersionId] : []
          )
        ),
        agentNames(
          member.workspaceId,
          rows.flatMap((row) => (row.agentId ? [row.agentId] : []))
        ),
        ownerNames(
          rows.flatMap((row) => (row.ownerUserId ? [row.ownerUserId] : []))
        ),
      ]);
    return rows.map((row) => ({
      agentName: row.agentId ? (agentLabel.get(row.agentId) ?? null) : null,
      artifactId: row.id,
      audience: row.audience,
      currentVersion: versionRows.get(row.currentVersionId ?? "")?.number ?? 1,
      description: row.description,
      hasThumbnail: row.thumbnailKey !== null,
      kind: row.kind,
      linkCount: links.get(row.id) ?? 0,
      ownerName: row.ownerUserId
        ? (ownerLabel.get(row.ownerUserId) ?? null)
        : null,
      ownerUserId: row.ownerUserId,
      pinned: pinned.has(row.id),
      title: row.title,
      updatedAt: row.updatedAt,
    }));
  };

  const list = async (
    principal: Principal,
    filters: ArtifactListFilters = {}
  ): Promise<{ items: ArtifactCard[]; next?: string }> => {
    const member = reader(principal, "artifacts.list");
    const rows = await listArtifacts(db, member.workspaceId, {
      after: filters.cursor ? decodeCursor(filters.cursor) : undefined,
      kind: filters.kind,
      limit: PAGE_SIZE,
      madeBy: filters.madeBy,
      now: nowIso(),
      runId: filters.runId,
      shared: filters.shared,
      visibility: visibilityOf(member),
    });
    const page = rows.slice(0, PAGE_SIZE);
    const last = page.at(-1);
    return {
      items: await cards(member, page),
      ...(rows.length > PAGE_SIZE && last ? { next: encodeCursor(last) } : {}),
    };
  };

  const currentOf = async (
    member: Member,
    row: ArtifactRow
  ): Promise<ArtifactVersionRow> => {
    const version = row.currentVersionId
      ? await findVersionById(db, member.workspaceId, row.currentVersionId)
      : null;
    if (!version) {
      throw notFound();
    }
    return version;
  };

  /** The session the artifact was made in, when this reader may see it. */
  const madeIn = async (member: Member, row: ArtifactRow) => {
    if (!(row.sessionId && row.runId)) {
      return null;
    }
    const filter = await visibleSessions(db, member);
    const [session] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.id, row.sessionId), filter))
      .limit(1);
    return session
      ? { runId: row.runId, sessionId: row.sessionId, title: null }
      : null;
  };

  const get = async (
    principal: Principal,
    artifactId: string
  ): Promise<ArtifactDetail> => {
    const member = reader(principal, "artifacts.get");
    const row = await visible(member, artifactId);
    const [version, [card], [workspace], made] = await Promise.all([
      currentOf(member, row),
      cards(member, [row]),
      db
        .select({ enabled: workspaces.artifactLinksEnabled })
        .from(workspaces)
        .where(eq(workspaces.id, member.workspaceId))
        .limit(1),
      madeIn(member, row),
    ]);
    if (!card) {
      throw notFound();
    }
    const record = policyRecord(row);
    return {
      ...card,
      canCreateLiveLink:
        member.kind === "user" &&
        record.ownerUserId !== null &&
        record.ownerUserId === member.userId,
      canManage:
        member.kind === "user" && canManage(record, policyUser(member)),
      createdAt: row.createdAt,
      currentVersion: toVersion(version),
      handedToAgentId: row.handedToAgentId,
      linksEnabled: workspace?.enabled ?? true,
      madeIn: made,
    };
  };

  const versions = async (
    principal: Principal,
    artifactId: string
  ): Promise<ArtifactVersion[]> => {
    const member = reader(principal, "artifacts.versions");
    const row = await visible(member, artifactId);
    const rows = await listVersions(db, member.workspaceId, row.id);
    const files = await filesByVersionIds(
      db,
      member.workspaceId,
      rows.map((version) => version.id)
    );
    return rows.map((version) => ({
      ...toVersion(version),
      files: (files.get(version.id) ?? []).map(
        ({ contentType, path, size }) => ({ contentType, path, size })
      ),
    }));
  };

  /** The version a reader asks for: the number, else the current one. */
  const versionOf = async (
    member: Member,
    row: ArtifactRow,
    number: number | undefined
  ): Promise<ArtifactVersionRow> => {
    if (number === undefined) {
      return await currentOf(member, row);
    }
    const version = await findVersionByNumber(
      db,
      member.workspaceId,
      row.id,
      number
    );
    if (!version) {
      throw new ServiceError("not_found", "Version not found");
    }
    return version;
  };

  /** A run saves the PNG of a version it can see. It writes no event. */
  const setThumbnail = async (
    principal: Principal,
    input: { artifactId: string; png: Uint8Array; versionId: string }
  ): Promise<void> => {
    const member = writer(principal, "artifacts.setThumbnail");
    if (member.kind !== "run") {
      throw new ForbiddenError("artifacts.setThumbnail");
    }
    const row = await visible(member, input.artifactId);
    const version = await findVersionById(
      db,
      member.workspaceId,
      input.versionId
    );
    if (version?.artifactId !== row.id) {
      throw new ServiceError("not_found", "Version not found");
    }
    const key = thumbnailKey(member.workspaceId, version.id);
    await blobs.put(key, input.png);
    const statements: Statement[] = [
      db
        .update(artifactVersions)
        .set({ thumbnailKey: key })
        .where(
          and(
            eq(artifactVersions.id, version.id),
            eq(artifactVersions.workspaceId, member.workspaceId)
          )
        ),
    ];
    if (row.currentVersionId === version.id) {
      statements.push(
        db
          .update(artifacts)
          .set({ thumbnailKey: key })
          .where(
            and(
              eq(artifacts.id, row.id),
              eq(artifacts.workspaceId, member.workspaceId)
            )
          )
      );
    }
    await atomic(statements);
  };

  /** The PNG of a version (the current one by default). */
  const thumbnail = async (
    principal: Principal,
    artifactId: string,
    number?: number
  ): Promise<Uint8Array> => {
    const member = reader(principal, "artifacts.thumbnail");
    const row = await visible(member, artifactId);
    const version = await versionOf(member, row, number);
    const blob = version.thumbnailKey
      ? await blobs.get(version.thumbnailKey)
      : null;
    if (!blob) {
      throw new ServiceError("not_found", "Thumbnail not found");
    }
    return blob.bytes;
  };

  /** A zip of the files of a version (the current one by default). */
  const download = async (
    principal: Principal,
    artifactId: string,
    number?: number
  ): Promise<{ bytes: Uint8Array; filename: string }> => {
    const member = reader(principal, "artifacts.download");
    const row = await visible(member, artifactId);
    const version = await versionOf(member, row, number);
    const files = await versionFiles(db, member.workspaceId, version.id);
    const blobsOfFiles = await Promise.all(
      files.map((file) => blobs.get(blobKey(member.workspaceId, file.sha256)))
    );
    const entries: Record<string, Uint8Array> = {};
    for (const [index, file] of files.entries()) {
      const blob = blobsOfFiles[index];
      if (!blob) {
        throw new ServiceError("not_found", `File ${file.path} not found`);
      }
      entries[file.path] = blob.bytes;
    }
    const slug = row.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return {
      bytes: zipSync(entries),
      filename: `${slug || "artifact"}-v${version.number}.zip`,
    };
  };

  /** The text of one file of a version (the current one by default; the entry by default). */
  const readFile = async (
    principal: Principal,
    input: { artifactId: string; path?: string; version?: number }
  ): Promise<ArtifactFileText> => {
    const member = reader(principal, "artifacts.read");
    const row = await visible(member, input.artifactId);
    const version =
      input.version === undefined
        ? await currentOf(member, row)
        : await findVersionByNumber(
            db,
            member.workspaceId,
            row.id,
            input.version
          );
    if (!version) {
      throw new ServiceError("not_found", "Version not found");
    }
    const path = input.path ?? version.entry;
    const file = (await versionFiles(db, member.workspaceId, version.id)).find(
      (candidate) => candidate.path === path
    );
    if (!file) {
      throw new ServiceError("not_found", `File ${path} not found`);
    }
    if (!TEXT_TYPE.test(file.contentType)) {
      throw invalid(`${path} is not a text file (${file.contentType})`);
    }
    const blob = await blobs.get(blobKey(member.workspaceId, file.sha256));
    if (!blob) {
      throw new ServiceError("not_found", `File ${path} not found`);
    }
    return {
      contentType: file.contentType,
      path,
      size: file.size,
      text: new TextDecoder().decode(blob.bytes),
      version: version.number,
    };
  };

  return {
    create,
    download,
    get,
    list,
    readFile,
    remove,
    rename,
    restore,
    setAudience,
    setThumbnail,
    thumbnail,
    update,
    versions,
  };
};

export type ArtifactsService = ReturnType<typeof createArtifactsService>;
