/**
 * Files (contract C6). Bytes live in blob storage under
 * `${workspaceId}/files/${id}`, the row in `files`. A user uploads for
 * themselves and a run uploads its outputs. Downloads are narrower: a user
 * reads any file in the workspace, a run reads only the files its run lists.
 * Every refusal to download is `not_found`, so a caller cannot tell a file
 * that exists from one it may not read.
 */
import type { Database } from "@repo/db";
import { files } from "@repo/db/schema/files";
import { runs } from "@repo/db/schema/runs";
import { type FileSource, MAX_FILE_BYTES } from "@repo/db/shared";
import { and, eq, inArray } from "drizzle-orm";
import { ulid } from "ulidx";
import { z } from "zod";
import { authorize, ForbiddenError } from "./authz.ts";
import { ServiceError } from "./errors.ts";
import type { Clock } from "./runs/types.ts";
import type { Principal } from "./workspaces.ts";

const UPLOAD_ACTION = "files.upload";
const DESCRIBE_ACTION = "files.describe";
const FILE_KIND = "file";
const DESCRIBE_MAX_IDS = 100;
const NAME_MAX_CHARS = 200;
const FALLBACK_NAME = "file";
const FALLBACK_MIME = "application/octet-stream";
const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const PATH_SEPARATOR = /[\\/]/;
const CONTROL_CHARS = /\p{Cc}/gu;

/** Blob storage: R2 in the app, a Map in tests. */
export interface FileBlobs {
  delete: (key: string) => Promise<void>;
  get: (key: string) => Promise<ReadableStream<Uint8Array> | null>;
  put: (key: string, body: Blob, contentType: string) => Promise<void>;
}

export interface FileRecord {
  createdAt: string;
  id: string;
  mime: string;
  name: string;
  runId: string | null;
  size: number;
  source: FileSource;
}

type FileRow = typeof files.$inferSelect;
type UserPrincipal = Extract<Principal, { kind: "user" }>;
type RunPrincipal = Extract<Principal, { kind: "run" }>;

const stringList = z.array(z.string());

const toRecord = (row: FileRow): FileRecord => ({
  createdAt: row.createdAt,
  id: row.id,
  mime: row.mime,
  name: row.name,
  runId: row.runId,
  size: row.size,
  source: row.source,
});

const notFound = () => new ServiceError("not_found", "File not found");

/** The last path segment, without control characters, trimmed and capped. */
const sanitizeName = (raw: string): string => {
  const last = raw.split(PATH_SEPARATOR).at(-1) ?? "";
  const clean = last.replace(CONTROL_CHARS, "").trim();
  if (clean === "") {
    return FALLBACK_NAME;
  }
  if ([...clean].length <= NAME_MAX_CHARS) {
    return clean;
  }
  const dot = clean.lastIndexOf(".");
  const extension = dot > 0 ? clean.slice(dot) : "";
  const kept = [...extension].length < NAME_MAX_CHARS ? extension : "";
  const stem = dot > 0 ? clean.slice(0, dot) : clean;
  return [...stem].slice(0, NAME_MAX_CHARS - [...kept].length).join("") + kept;
};

/** Lower-case `type/subtype` without parameters, or the octet-stream default. */
const sanitizeMime = (raw: string | null): string => {
  const [essence = ""] = (raw ?? "").split(";");
  const normalised = essence.trim().toLowerCase();
  return MIME_PATTERN.test(normalised) ? normalised : FALLBACK_MIME;
};

/** Who an upload is stamped with. Only users and runs upload. */
const uploadScope = (
  principal: Principal
): {
  createdById: string;
  createdByKind: "user" | "agent";
  runId: string | null;
  source: FileSource;
  workspaceId: string;
} => {
  if (principal.kind === "user") {
    return {
      createdById: principal.userId,
      createdByKind: "user",
      runId: null,
      source: principal.via === "slack" ? "slack" : "upload",
      workspaceId: principal.workspaceId,
    };
  }
  if (principal.kind === "run") {
    return {
      createdById: principal.agentId,
      createdByKind: "agent",
      runId: principal.runId,
      source: "run",
      workspaceId: principal.workspaceId,
    };
  }
  throw new ForbiddenError(UPLOAD_ACTION);
};

const requireUser = (principal: Principal): UserPrincipal => {
  if (principal.kind !== "user") {
    throw new ForbiddenError(DESCRIBE_ACTION);
  }
  return principal;
};

export const createFilesService = ({
  blobs,
  clock,
  db,
}: {
  blobs: FileBlobs;
  clock: Clock;
  db: Database;
}) => {
  const fileInWorkspace = async (
    workspaceId: string,
    fileId: string
  ): Promise<FileRow | null> => {
    const [row] = await db
      .select()
      .from(files)
      .where(and(eq(files.id, fileId), eq(files.workspaceId, workspaceId)))
      .limit(1);
    return row ?? null;
  };

  /** Whether the run is allowed to read the file: it lists it as input or output. */
  const runListsFile = async (
    principal: RunPrincipal,
    fileId: string
  ): Promise<boolean> => {
    const [run] = await db
      .select({
        inputFileIds: runs.inputFileIds,
        outputFileIds: runs.outputFileIds,
      })
      .from(runs)
      .where(
        and(
          eq(runs.id, principal.runId),
          eq(runs.workspaceId, principal.workspaceId)
        )
      )
      .limit(1);
    if (!run) {
      return false;
    }
    const listed = [
      ...stringList.parse(JSON.parse(run.inputFileIds)),
      ...stringList.parse(JSON.parse(run.outputFileIds)),
    ];
    return listed.includes(fileId);
  };

  const readableFile = async (
    principal: Principal,
    fileId: string
  ): Promise<FileRow | null> => {
    if (principal.kind === "user") {
      return fileInWorkspace(principal.workspaceId, fileId);
    }
    if (principal.kind === "run" && (await runListsFile(principal, fileId))) {
      return fileInWorkspace(principal.workspaceId, fileId);
    }
    return null;
  };

  const upload = async (
    principal: Principal,
    { body, mime, name }: { body: Blob; mime: string | null; name: string }
  ): Promise<FileRecord> => {
    const scope = uploadScope(principal);
    authorize(principal, UPLOAD_ACTION, {
      kind: FILE_KIND,
      workspaceId: scope.workspaceId,
    });
    if (body.size > MAX_FILE_BYTES) {
      throw new ServiceError("invalid", "Files are limited to 50 MB");
    }
    const id = ulid();
    const row: FileRow = {
      createdAt: clock.now().toISOString(),
      createdById: scope.createdById,
      createdByKind: scope.createdByKind,
      id,
      mime: sanitizeMime(mime),
      name: sanitizeName(name),
      r2Key: `${scope.workspaceId}/files/${id}`,
      runId: scope.runId,
      size: body.size,
      source: scope.source,
      workspaceId: scope.workspaceId,
    };
    await blobs.put(row.r2Key, body, row.mime);
    try {
      await db.insert(files).values(row);
    } catch (error) {
      await blobs.delete(row.r2Key).catch(() => undefined);
      throw error;
    }
    return toRecord(row);
  };

  const download = async (
    principal: Principal,
    fileId: string
  ): Promise<{ body: ReadableStream<Uint8Array>; file: FileRecord }> => {
    const row = await readableFile(principal, fileId);
    const body = row ? await blobs.get(row.r2Key) : null;
    if (!(row && body)) {
      throw notFound();
    }
    return { body, file: toRecord(row) };
  };

  const describe = async (
    principal: Principal,
    fileIds: readonly string[]
  ): Promise<FileRecord[]> => {
    const user = requireUser(principal);
    authorize(user, DESCRIBE_ACTION, {
      kind: FILE_KIND,
      workspaceId: user.workspaceId,
    });
    if (fileIds.length > DESCRIBE_MAX_IDS) {
      throw new ServiceError(
        "invalid",
        `At most ${DESCRIBE_MAX_IDS} files can be described at once`
      );
    }
    const rows = await db
      .select()
      .from(files)
      .where(
        and(
          eq(files.workspaceId, user.workspaceId),
          inArray(files.id, [...fileIds])
        )
      );
    const byId = new Map(rows.map((row) => [row.id, toRecord(row)]));
    return fileIds.flatMap((id) => {
      const record = byId.get(id);
      return record ? [record] : [];
    });
  };

  return { describe, download, upload };
};

export type FilesService = ReturnType<typeof createFilesService>;
