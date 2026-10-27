/**
 * The central skill store (SK.1). A skill is a named, versioned file tree that
 * any agent can carry. Every commit makes a new version holding the whole
 * tree, so a version is never a delta. File bytes live once in blob storage
 * under `skill-blobs/<sha256>`, and the rows in D1 point at them.
 *
 * People commit, import and approve. An agent's run may create skills it owns
 * and commit to them, but its versions start `proposed` and a person approves
 * or rejects them. An assignment hands an agent the latest approved version of
 * a skill, or the one it is pinned to. Only approved versions reach another
 * agent. The proposing agent reads and tests its own proposed versions by
 * number.
 *
 * A name is unique among one owner's skills (an agent's, or the people's), so
 * two agents may each own a skill of the same name, as they could in the
 * library. An agent carries at most one assigned skill per name.
 *
 * Workspaces that kept skills in the library are migrated on first access.
 */
import type { Database } from "@repo/db";
import type { Atomic, Statement } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import { runs } from "@repo/db/schema/runs";
import {
  skillAssignments,
  skillLibraryMigrations,
  skillSources,
  skills,
  skillVersionFiles,
  skillVersions,
} from "@repo/db/schema/skills";
import type { EventType, RunStatus, SkillAuthorKind } from "@repo/db/shared";
import { SKILLS_MAX_BYTES, SKILLS_MAX_FILES } from "@repo/protocol/skills";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { ulid } from "ulidx";
import { z } from "zod";
import { findAgent } from "./agents.ts";
import { authorize, ForbiddenError } from "./authz.ts";
import { isUniqueViolation, ServiceError } from "./errors.ts";
import type { EventsService } from "./events.ts";
import type { Clock } from "./runs/types.ts";
import { packArchive, unpackArchive } from "./skills-store/archive.ts";
import { isTextBytes, unifiedDiff } from "./skills-store/diff.ts";
import {
  type GithubSkillFetcher,
  githubLocation,
  hasGithubUpdate,
  type ImportGithubInput,
} from "./skills-store/github.ts";
import {
  readLibrarySkills,
  type SkillsSourceLibrary,
} from "./skills-store/library-source.ts";
import { assertSafePath, assertTreeShape } from "./skills-store/paths.ts";
import {
  type AssignInput,
  type AssignmentRecord,
  assignInputSchema,
  type CommitInput,
  type CreateInput,
  commitInputSchema,
  createInputSchema,
  type DecideInput,
  type DiffInput,
  type DiffResult,
  decideInputSchema,
  diffInputSchema,
  type ExportInput,
  exportInputSchema,
  type FileRecord,
  type FileWrite,
  type ForAgentOptions,
  forAgentOptionsSchema,
  type MigrationResult,
  type PinInput,
  pinInputSchema,
  type ResolvedSkill,
  type RevertInput,
  revertInputSchema,
  type ShownVersion,
  type SkillRecord,
  skillRefSchema,
  toVersionRecord,
  type VersionRecord,
  type VersionRefInput,
  versionRefSchema,
} from "./skills-store/records.ts";
import {
  assertSkillName,
  assertTree,
  type PlannedFile,
  sameTree,
  sha256Hex,
  type TreeFile,
} from "./skills-store/tree.ts";
import type { Principal } from "./workspaces.ts";

const SKILL_KIND = "skill";
/** D1 binds at most 100 parameters per statement. A file row binds 6, an assignment 5. */
const ROWS_PER_INSERT = 15;
/** One hash binds one parameter, and D1 binds at most 100 per statement. */
const HASHES_PER_QUERY = 90;
const ARCHIVE_MAX_BYTES = SKILLS_MAX_BYTES * 2;
const MIGRATION_AUTHOR = "migration";

/** Blob storage for file bytes: R2 in the app, a Map in tests. Keys are full object keys. */
export interface SkillBlobs {
  /** Whether an object is stored under the key. */
  exists: (key: string) => Promise<boolean>;
  get: (key: string) => Promise<Uint8Array | null>;
  /** Stores the bytes. The key is their hash, so storing the same key again is harmless. */
  put: (key: string, bytes: Uint8Array) => Promise<void>;
  /** Removes the object. Removing a key that is not stored is harmless. */
  remove: (key: string) => Promise<void>;
}

type SkillEvent = Extract<EventType, `skill.${string}`>;
type EventPayload = Record<string, boolean | number | string | null>;
type SkillRow = typeof skills.$inferSelect;
type VersionRow = typeof skillVersions.$inferSelect;
type FileRow = typeof skillVersionFiles.$inferSelect;

/** Who is acting, reduced to what the rules need. */
interface Caller {
  agentId: string | null;
  id: string;
  kind: "agent" | "system" | "user";
  runId: string | null;
  workspaceId: string;
}

/** A new version to write, with its tree already hashed and checked. */
interface Publication {
  /** Also hand the new skill to this agent, following the latest approved version. */
  assignTo?: string;
  caller: Caller;
  conflict: string;
  event: SkillEvent;
  eventExtra?: EventPayload;
  files: PlannedFile[];
  id: string;
  message: string;
  /** Set for the first version of a new skill. */
  newSkill?: { name: string; ownerAgentId: string | null };
  number: number;
  parentNumber: number | null;
  /** The tree the version was made on. A version equal to it is refused. */
  previous: readonly TreeFile[] | null;
  skill: { id: string; name: string };
  source?: {
    repoUrl: string;
    path: string | null;
    ref: string;
    commitSha: string;
  };
  sourceCommitSha?: string;
  status?: "approved" | "proposed";
}

const notFound = () => new ServiceError("not_found", "Not found");
const invalid = (message: string) => new ServiceError("invalid", message);
const conflict = (message: string) => new ServiceError("conflict", message);

const blobKey = (hash: string) => `skill-blobs/${hash}`;

const encoder = new TextEncoder();

const chunks = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
};

const byPath = (left: { path: string }, right: { path: string }): number => {
  if (left.path === right.path) {
    return 0;
  }
  return left.path < right.path ? -1 : 1;
};

const toTreeFile = (row: FileRow): TreeFile => ({
  executable: row.executable,
  hash: row.hash,
  path: row.path,
  size: row.size,
});

const toFileRecord = (file: TreeFile): FileRecord => ({
  executable: file.executable,
  hash: file.hash,
  path: file.path,
  size: file.size,
});

/** The newest version that is not rejected: the one a commit has to be made on. */
const headOf = (versions: readonly VersionRow[]): VersionRow | undefined =>
  versions.find((version) => version.status !== "rejected");

/**
 * `target` and the proposed versions made on top of it, directly or through
 * other proposals. Rejecting a version rejects these too: they carry its
 * changes and could never be approved.
 */
const proposalsBuiltOn = (
  versions: readonly VersionRow[],
  target: VersionRow
): VersionRow[] => {
  const settled = new Map([[target.number, target]]);
  const ascending = [...versions].sort((a, b) => a.number - b.number);
  for (const version of ascending) {
    if (
      version.status === "proposed" &&
      version.parentNumber !== null &&
      settled.has(version.parentNumber)
    ) {
      settled.set(version.number, version);
    }
  }
  return [...settled.values()];
};

/** Refuses to settle a version that is not proposed, or to approve one whose base is no longer the latest approved version. */
const assertCanSettle = (
  versions: readonly VersionRow[],
  target: VersionRow,
  outcome: "approved" | "rejected"
): void => {
  if (target.status !== "proposed") {
    throw conflict(
      `Version ${target.number} is ${target.status}, not proposed`
    );
  }
  if (outcome !== "approved") {
    return;
  }
  const latestApproved =
    versions.find((version) => version.status === "approved")?.number ?? null;
  if (latestApproved !== target.parentNumber) {
    throw conflict(
      `Version ${target.number} was made on version ${target.parentNumber ?? "none"}, but the latest approved version is ${latestApproved ?? "none"}. Redo the change on top of it.`
    );
  }
};

export const createSkillsStoreService = ({
  atomic,
  blobs,
  clock,
  db,
  events,
  library,
  github,
  githubToken,
}: {
  github?: GithubSkillFetcher;
  githubToken?: string;
  atomic: Atomic;
  blobs: SkillBlobs;
  clock: Clock;
  db: Database;
  events: Pick<EventsService, "insertStatement">;
  library: SkillsSourceLibrary;
}) => {
  const migratedWorkspaces = new Set<string>();

  // --- who is calling ---

  /** A person or an agent's run. A read-only key may not write. Everyone else is refused. */
  const memberOf = (
    principal: Principal,
    action: string,
    write: boolean
  ): Caller => {
    if (principal.kind === "run") {
      authorize(principal, action, {
        kind: SKILL_KIND,
        workspaceId: principal.workspaceId,
      });
      return {
        agentId: principal.agentId,
        id: principal.agentId,
        kind: "agent",
        runId: principal.runId,
        workspaceId: principal.workspaceId,
      };
    }
    if (principal.kind !== "user") {
      throw new ForbiddenError(action);
    }
    const readOnly =
      principal.apiKey?.access === "read" ||
      principal.oauthClient?.access === "read";
    if (write && readOnly) {
      throw new ForbiddenError(action);
    }
    authorize(principal, action, {
      kind: SKILL_KIND,
      workspaceId: principal.workspaceId,
    });
    return {
      agentId: null,
      id: principal.userId,
      kind: "user",
      runId: null,
      workspaceId: principal.workspaceId,
    };
  };

  /** A person who may write. A run is refused, whatever it owns. */
  const peopleOf = (principal: Principal, action: string): Caller => {
    if (principal.kind !== "user") {
      throw new ForbiddenError(action);
    }
    return memberOf(principal, action, true);
  };

  // --- reading rows ---

  /** Whether the agent already carries an assigned skill of this name. */
  const carriesName = async (
    agentId: string,
    name: string
  ): Promise<boolean> => {
    const carried = await db
      .select({ id: skills.id })
      .from(skillAssignments)
      .innerJoin(skills, eq(skills.id, skillAssignments.skillId))
      .where(
        and(
          eq(skillAssignments.agentId, agentId),
          eq(skills.name, name),
          eq(skills.deleted, false)
        )
      )
      .limit(1);
    return carried.length > 0;
  };

  /** The agent a new skill is assigned to: its owner, unless it carries a skill of that name already. */
  const ownerToAssign = async (
    c: Caller,
    name: string
  ): Promise<string | undefined> =>
    c.agentId && !(await carriesName(c.agentId, name)) ? c.agentId : undefined;

  const isAssigned = async (
    workspaceId: string,
    agentId: string,
    skillId: string
  ): Promise<boolean> => {
    const [row] = await db
      .select({ skillId: skillAssignments.skillId })
      .from(skillAssignments)
      .where(
        and(
          eq(skillAssignments.workspaceId, workspaceId),
          eq(skillAssignments.agentId, agentId),
          eq(skillAssignments.skillId, skillId)
        )
      )
      .limit(1);
    return row !== undefined;
  };

  /** A skill the caller may see: any for a person, an owned or assigned one for a run. Others are not found. */
  const skillFor = async (c: Caller, skillId: string): Promise<SkillRow> => {
    const [row] = await db
      .select()
      .from(skills)
      .where(
        and(
          eq(skills.id, skillId),
          eq(skills.workspaceId, c.workspaceId),
          eq(skills.deleted, false)
        )
      )
      .limit(1);
    if (!row) {
      throw notFound();
    }
    if (
      c.agentId !== null &&
      row.ownerAgentId !== c.agentId &&
      !(await isAssigned(c.workspaceId, c.agentId, row.id))
    ) {
      throw notFound();
    }
    return row;
  };

  /** A skill the caller may commit to: a person any, a run only the skills its agent owns. */
  const writableSkill = async (
    c: Caller,
    skillId: string,
    action: string
  ): Promise<SkillRow> => {
    const row = await skillFor(c, skillId);
    if (c.agentId !== null && row.ownerAgentId !== c.agentId) {
      throw new ForbiddenError(action);
    }
    return row;
  };

  /** Whether the caller may see a version. A run sees approved ones and its own agent's proposals. */
  const visibleTo = (c: Caller, version: VersionRow): boolean =>
    c.agentId === null ||
    version.status === "approved" ||
    (version.authorKind === "agent" && version.authorId === c.agentId);

  /** Every version of a skill, newest first, rejected ones included. */
  const versionsOf = (skillId: string): Promise<VersionRow[]> =>
    db
      .select()
      .from(skillVersions)
      .where(eq(skillVersions.skillId, skillId))
      .orderBy(desc(skillVersions.number));

  const versionFor = async (
    c: Caller,
    skillId: string,
    number: number
  ): Promise<VersionRow> => {
    const [row] = await db
      .select()
      .from(skillVersions)
      .where(
        and(
          eq(skillVersions.skillId, skillId),
          eq(skillVersions.number, number)
        )
      )
      .limit(1);
    if (!(row && visibleTo(c, row))) {
      throw notFound();
    }
    return row;
  };

  const treeOf = async (versionId: string): Promise<TreeFile[]> => {
    const rows = await db
      .select()
      .from(skillVersionFiles)
      .where(eq(skillVersionFiles.versionId, versionId));
    return rows.map(toTreeFile).sort(byPath);
  };

  const contentOf = async (hash: string): Promise<Uint8Array> => {
    const bytes = await blobs.get(blobKey(hash));
    if (!bytes) {
      throw new ServiceError("not_found", "A file of this version is missing");
    }
    return bytes;
  };

  const withContents = (files: readonly TreeFile[]): Promise<FileRecord[]> =>
    Promise.all(
      files.map(async (file) => ({
        ...toFileRecord(file),
        content: await contentOf(file.hash),
      }))
    );

  const asRecords = (
    files: readonly TreeFile[],
    contents: boolean
  ): Promise<FileRecord[]> | FileRecord[] =>
    contents ? withContents(files) : files.map(toFileRecord);

  // --- writing rows ---

  const eventStatement = (
    c: Caller,
    type: SkillEvent,
    payload: EventPayload,
    agentId: string | null = c.agentId
  ): Statement =>
    events.insertStatement({
      actor: { id: c.id, kind: c.kind },
      agentId: agentId ?? undefined,
      payload,
      runId: c.runId ?? undefined,
      type,
      workspaceId: c.workspaceId,
    });

  /** The inserts that make one version: the skill row when new, the version, its files and the event. */
  const publicationStatements = (p: Publication, now: string): Statement[] => {
    const { caller } = p;
    const approved = p.status
      ? p.status === "approved"
      : caller.kind !== "agent";
    const authorKind: SkillAuthorKind = caller.kind;
    const statements: Statement[] = [];
    if (p.newSkill) {
      statements.push(
        db.insert(skills).values({
          createdAt: now,
          createdBy: caller.id,
          createdByKind: authorKind,
          id: p.skill.id,
          name: p.newSkill.name,
          ownerAgentId: p.newSkill.ownerAgentId,
          updatedAt: now,
          workspaceId: caller.workspaceId,
        })
      );
    } else {
      statements.push(
        db
          .update(skills)
          .set({ updatedAt: now })
          .where(eq(skills.id, p.skill.id))
      );
    }
    statements.push(
      db.insert(skillVersions).values({
        approvedAt: approved ? now : null,
        approvedBy: approved ? caller.id : null,
        authorId: caller.id,
        authorKind,
        authorRunId: caller.runId,
        createdAt: now,
        id: p.id,
        message: p.message,
        number: p.number,
        parentNumber: p.parentNumber,
        skillId: p.skill.id,
        sourceCommitSha: p.sourceCommitSha,
        status: approved ? "approved" : "proposed",
        workspaceId: caller.workspaceId,
      })
    );
    if (p.source) {
      const source = {
        ...p.source,
        checkedAt: null,
        latestCommitSha: null,
        provider: "github" as const,
        skillId: p.skill.id,
        updatedAt: now,
        workspaceId: caller.workspaceId,
      };
      // A proposed version leaves an existing source alone: the pin moves when
      // `decide` approves the version.
      const insert = db
        .insert(skillSources)
        .values({ ...source, createdAt: now });
      statements.push(
        approved
          ? insert.onConflictDoUpdate({
              set: source,
              target: skillSources.skillId,
            })
          : insert.onConflictDoNothing()
      );
    }
    for (const rows of chunks(p.files, ROWS_PER_INSERT)) {
      statements.push(
        db.insert(skillVersionFiles).values(
          rows.map((file) => ({
            executable: file.executable,
            hash: file.hash,
            path: file.path,
            size: file.size,
            versionId: p.id,
            workspaceId: caller.workspaceId,
          }))
        )
      );
    }
    statements.push(
      eventStatement(caller, p.event, {
        name: p.skill.name,
        skillId: p.skill.id,
        status: approved ? "approved" : "proposed",
        version: p.number,
        ...p.eventExtra,
      })
    );
    if (p.newSkill && p.assignTo) {
      statements.push(
        db.insert(skillAssignments).values({
          agentId: p.assignTo,
          createdAt: now,
          pinnedVersionId: null,
          skillId: p.skill.id,
          workspaceId: caller.workspaceId,
        }),
        eventStatement(
          caller,
          "skill.assigned",
          { agentId: p.assignTo, name: p.skill.name, skillId: p.skill.id },
          p.assignTo
        )
      );
    }
    return statements;
  };

  /** Stores the new bytes of a publication, once per hash and only when no skill stored them before. A row never points at a missing blob. */
  const storeBlobs = async (files: readonly PlannedFile[]): Promise<void> => {
    const fresh = new Map<string, Uint8Array>();
    for (const file of files) {
      if (file.bytes) {
        fresh.set(file.hash, file.bytes);
      }
    }
    await Promise.all(
      [...fresh].map(async ([hash, bytes]) => {
        if (!(await blobs.exists(blobKey(hash)))) {
          await blobs.put(blobKey(hash), bytes);
        }
      })
    );
  };

  /** Checks the tree, stores the bytes and writes the version, the files and the event together. */
  const publish = async (p: Publication): Promise<VersionRecord> => {
    assertTree(p.skill.name, p.files);
    // A different upstream commit is reviewable even when its skill files are identical.
    if (!p.sourceCommitSha && p.previous && sameTree(p.previous, p.files)) {
      throw invalid("Nothing changed from the base version");
    }
    await storeBlobs(p.files);
    const now = clock.now().toISOString();
    try {
      await atomic(publicationStatements(p, now));
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict(p.conflict);
      }
      throw error;
    }
    const approved = p.status
      ? p.status === "approved"
      : p.caller.kind !== "agent";
    return {
      approvedAt: approved ? now : null,
      approvedBy: approved ? p.caller.id : null,
      author: {
        id: p.caller.id,
        kind: p.caller.kind,
        runId: p.caller.runId,
      },
      createdAt: now,
      id: p.id,
      message: p.message,
      number: p.number,
      parent: p.parentNumber,
      skillId: p.skill.id,
      status: approved ? "approved" : "proposed",
    };
  };

  /** Hashes the incoming writes. A file whose bytes match the previous tree is carried, not stored again. */
  const planWrites = (
    incoming: readonly FileWrite[],
    previous: ReadonlyMap<string, TreeFile>
  ): Promise<PlannedFile[]> =>
    Promise.all(
      incoming.map(async (write) => {
        assertSafePath(write.path);
        const bytes =
          typeof write.content === "string"
            ? encoder.encode(write.content)
            : write.content;
        const before = previous.get(write.path);
        const hash = await sha256Hex(bytes);
        const executable = write.executable ?? before?.executable ?? false;
        const unchanged = before?.hash === hash;
        return {
          bytes: unchanged ? undefined : bytes,
          executable,
          hash,
          path: write.path,
          size: bytes.byteLength,
        };
      })
    );

  // --- the library migration ---

  const hasMigrated = async (workspaceId: string): Promise<boolean> => {
    const [row] = await db
      .select({ workspaceId: skillLibraryMigrations.workspaceId })
      .from(skillLibraryMigrations)
      .where(eq(skillLibraryMigrations.workspaceId, workspaceId))
      .limit(1);
    return row !== undefined;
  };

  /** Which agents carry which migrated skill: an own skill hides a shared one of the same name. */
  const migrationAssignments = (
    migrated: readonly {
      id: string;
      name: string;
      ownerAgentId: string | null;
    }[],
    agentIds: readonly string[],
    ownFolders: ReadonlyMap<string, ReadonlySet<string>>
  ): { agentId: string; skillId: string }[] => {
    const out: { agentId: string; skillId: string }[] = [];
    for (const skill of migrated) {
      if (skill.ownerAgentId !== null) {
        out.push({ agentId: skill.ownerAgentId, skillId: skill.id });
        continue;
      }
      for (const agentId of agentIds) {
        if (!ownFolders.get(agentId)?.has(skill.name)) {
          out.push({ agentId, skillId: skill.id });
        }
      }
    }
    return out;
  };

  /**
   * Moves the workspace's library skills into the store, once. Each
   * `skills/<agentId>/<name>/` folder becomes a skill owned by that agent,
   * each `skills/_shared/<name>/` one a people-owned skill, all at version 1,
   * approved. Own skills are assigned to their agent, shared ones to every
   * agent that has no own folder of the same name. The library files stay
   * where they are. Everything lands in one atomic write with the marker, so
   * a run that fails leaves nothing behind and the next call tries again.
   */
  const migrateLibrary = async (
    principal: Principal
  ): Promise<MigrationResult> => {
    const c = memberOf(principal, "skills.migrate", false);
    const none: MigrationResult = { migrated: 0, skipped: [] };
    if (migratedWorkspaces.has(c.workspaceId)) {
      return none;
    }
    if (await hasMigrated(c.workspaceId)) {
      migratedWorkspaces.add(c.workspaceId);
      return none;
    }
    const agentIds = (
      await db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.workspaceId, c.workspaceId))
        .orderBy(asc(agents.id))
    ).map((row) => row.id);
    // The migration moves the whole workspace's skill folders, so it reads
    // as a person, whatever run or key started it.
    const snapshot = await readLibrarySkills(
      library,
      {
        kind: "user",
        userId: MIGRATION_AUTHOR,
        via: "session",
        workspaceId: c.workspaceId,
      },
      new Set(agentIds)
    );
    const system: Caller = {
      agentId: null,
      id: MIGRATION_AUTHOR,
      kind: "system",
      runId: null,
      workspaceId: c.workspaceId,
    };
    const now = clock.now().toISOString();
    const migrated = snapshot.skills.map((skill) => ({
      id: ulid(),
      name: skill.name,
      ownerAgentId: skill.ownerAgentId,
      skill,
      versionId: ulid(),
    }));
    await storeBlobs(migrated.flatMap((entry) => entry.skill.files));
    const statements: Statement[] = [];
    for (const entry of migrated) {
      statements.push(
        ...publicationStatements(
          {
            caller: system,
            conflict: "Already migrated",
            event: "skill.created",
            eventExtra: { migrated: true },
            files: entry.skill.files,
            id: entry.versionId,
            message: "Moved from the library",
            newSkill: {
              name: entry.name,
              ownerAgentId: entry.ownerAgentId,
            },
            number: 1,
            parentNumber: null,
            previous: null,
            skill: { id: entry.id, name: entry.name },
          },
          now
        )
      );
    }
    const assignments = migrationAssignments(
      migrated,
      agentIds,
      snapshot.ownFolders
    );
    for (const rows of chunks(assignments, ROWS_PER_INSERT)) {
      statements.push(
        db.insert(skillAssignments).values(
          rows.map((row) => ({
            agentId: row.agentId,
            createdAt: now,
            pinnedVersionId: null,
            skillId: row.skillId,
            workspaceId: c.workspaceId,
          }))
        )
      );
    }
    statements.push(
      db
        .insert(skillLibraryMigrations)
        .values({ migratedAt: now, workspaceId: c.workspaceId })
    );
    try {
      await atomic(statements);
    } catch (error) {
      // A request that raced us wrote the same rows first, and the unique indexes refused ours.
      if (isUniqueViolation(error) && (await hasMigrated(c.workspaceId))) {
        migratedWorkspaces.add(c.workspaceId);
        return none;
      }
      throw error;
    }
    migratedWorkspaces.add(c.workspaceId);
    return { migrated: migrated.length, skipped: snapshot.skipped };
  };

  const ensureMigrated = async (principal: Principal): Promise<void> => {
    await migrateLibrary(principal);
  };

  // --- reading ---

  /** The skills the caller may see, by name: all for a person, the owned and assigned ones for a run. */
  const list = async (principal: Principal): Promise<SkillRecord[]> => {
    const c = memberOf(principal, "skills.read", false);
    await ensureMigrated(principal);
    const rows = await db
      .select()
      .from(skills)
      .where(
        and(eq(skills.workspaceId, c.workspaceId), eq(skills.deleted, false))
      )
      .orderBy(asc(skills.name), asc(skills.ownerAgentId), asc(skills.id));
    const assigned =
      c.agentId === null
        ? new Set<string>()
        : new Set(
            (
              await db
                .select({ skillId: skillAssignments.skillId })
                .from(skillAssignments)
                .where(
                  and(
                    eq(skillAssignments.workspaceId, c.workspaceId),
                    eq(skillAssignments.agentId, c.agentId)
                  )
                )
            ).map((row) => row.skillId)
          );
    const seen = c.agentId === null ? undefined : agentSees(c.agentId);
    const latest = await db
      .select({
        approved: sql<
          number | null
        >`max(case when ${skillVersions.status} = 'approved' then ${skillVersions.number} end)`,
        latest: sql<
          number | null
        >`max(case when ${skillVersions.status} <> 'rejected' then ${skillVersions.number} end)`,
        skillId: skillVersions.skillId,
      })
      .from(skillVersions)
      .where(and(eq(skillVersions.workspaceId, c.workspaceId), seen))
      .groupBy(skillVersions.skillId);
    const sources = await db
      .select()
      .from(skillSources)
      .where(eq(skillSources.workspaceId, c.workspaceId));
    const sourceBySkill = new Map(
      sources.map((source) => [source.skillId, source])
    );
    const numbers = new Map(latest.map((row) => [row.skillId, row]));
    return rows
      .filter(
        (row) =>
          c.agentId === null ||
          row.ownerAgentId === c.agentId ||
          assigned.has(row.id)
      )
      .map((row) => ({
        createdAt: row.createdAt,
        id: row.id,
        latestApprovedVersion: numbers.get(row.id)?.approved ?? null,
        latestVersion: numbers.get(row.id)?.latest ?? null,
        name: row.name,
        ownerAgentId: row.ownerAgentId,
        source: sourceBySkill.get(row.id) ?? null,
        updatedAt: row.updatedAt,
      }));
  };

  /** The versions an agent's run may see, as a SQL condition: approved ones and its own proposals. */
  const agentSees = (agentId: string) =>
    or(
      eq(skillVersions.status, "approved"),
      and(
        eq(skillVersions.authorKind, "agent"),
        eq(skillVersions.authorId, agentId)
      )
    );

  /** The versions of a skill the caller may see, newest first. */
  const log = async (
    principal: Principal,
    input: { skillId: string }
  ): Promise<VersionRecord[]> => {
    const c = memberOf(principal, "skills.read", false);
    await ensureMigrated(principal);
    const parsed = skillRefSchema.parse(input);
    const skill = await skillFor(c, parsed.skillId);
    return (await versionsOf(skill.id))
      .filter((version) => visibleTo(c, version))
      .map(toVersionRecord);
  };

  /** One version with its file tree. File contents come along when `withContents` is true. */
  const show = async (
    principal: Principal,
    input: VersionRefInput
  ): Promise<ShownVersion> => {
    const c = memberOf(principal, "skills.read", false);
    await ensureMigrated(principal);
    const parsed = versionRefSchema.parse(input);
    const skill = await skillFor(c, parsed.skillId);
    const version = await versionFor(c, skill.id, parsed.version);
    const tree = await treeOf(version.id);
    return {
      files: await asRecords(tree, parsed.withContents),
      source: await sourceOf(skill.id),
      version: toVersionRecord(version),
    };
  };

  const textOf = (bytes: Uint8Array): string | null =>
    isTextBytes(bytes) ? new TextDecoder().decode(bytes) : null;

  /** The patch for one path, or null when either side is not text. */
  const patchFor = async (
    path: string,
    before: TreeFile | undefined,
    after: TreeFile | undefined
  ): Promise<string | null> => {
    const [oldBytes, newBytes] = await Promise.all([
      before ? contentOf(before.hash) : null,
      after ? contentOf(after.hash) : null,
    ]);
    const oldText = oldBytes ? textOf(oldBytes) : null;
    const newText = newBytes ? textOf(newBytes) : null;
    if ((oldBytes && oldText === null) || (newBytes && newText === null)) {
      return null;
    }
    const patch = unifiedDiff(path, oldText, newText);
    return patch === "" ? null : patch;
  };

  /** One file of a version with its bytes, or `not_found` when the version has no such path. */
  const readFile = async (
    principal: Principal,
    input: { path: string; skillId: string; version: number }
  ): Promise<FileRecord> => {
    const c = memberOf(principal, "skills.read", false);
    await ensureMigrated(principal);
    const parsed = versionRefSchema.parse({
      skillId: input.skillId,
      version: input.version,
    });
    const skill = await skillFor(c, parsed.skillId);
    const version = await versionFor(c, skill.id, parsed.version);
    const file = (await treeOf(version.id)).find(
      (entry) => entry.path === input.path
    );
    if (!file) {
      throw new ServiceError(
        "not_found",
        `"${input.path}" is not in version ${parsed.version}`
      );
    }
    return {
      ...toFileRecord(file),
      content: await contentOf(file.hash),
    };
  };

  /** What changed between two versions: added, removed and changed paths, and a unified diff of each text file. */
  const diff = async (
    principal: Principal,
    input: DiffInput
  ): Promise<DiffResult> => {
    const c = memberOf(principal, "skills.read", false);
    await ensureMigrated(principal);
    const parsed = diffInputSchema.parse(input);
    const skill = await skillFor(c, parsed.skillId);
    const [from, to] = await Promise.all([
      versionFor(c, skill.id, parsed.from),
      versionFor(c, skill.id, parsed.to),
    ]);
    const [before, after] = await Promise.all([treeOf(from.id), treeOf(to.id)]);
    const was = new Map(before.map((file) => [file.path, file]));
    const now = new Map(after.map((file) => [file.path, file]));
    const added = after.filter((file) => !was.has(file.path));
    const removed = before.filter((file) => !now.has(file.path));
    const changed = after.filter((file) => {
      const old = was.get(file.path);
      return (
        old && (old.hash !== file.hash || old.executable !== file.executable)
      );
    });
    const touched = [...added, ...removed, ...changed].sort(byPath);
    const patches = await Promise.all(
      touched.map(async (file) => ({
        patch: await patchFor(
          file.path,
          was.get(file.path),
          now.get(file.path)
        ),
        path: file.path,
      }))
    );
    return {
      added: added.map((file) => file.path),
      changed: changed.map((file) => file.path),
      patches: patches.flatMap((entry) =>
        entry.patch === null ? [] : [{ patch: entry.patch, path: entry.path }]
      ),
      removed: removed.map((file) => file.path),
    };
  };

  // --- committing ---

  /**
   * The skill a commit goes to, with its versions and the head tree. The head
   * is the newest version that is not rejected. When every version was
   * rejected the newest one is the head and the next version keeps its files
   * except for what the commit changes, but has no parent (`parent` null), so
   * a person can approve it.
   */
  const headFor = async (c: Caller, skillId: string, action: string) => {
    const skill = await writableSkill(c, skillId, action);
    const versions = await versionsOf(skill.id);
    const open = headOf(versions);
    const head = open ?? versions[0];
    if (!head) {
      throw notFound();
    }
    return {
      head,
      parent: open ? open.number : null,
      previous: await treeOf(head.id),
      skill,
      versions,
    };
  };

  const staleBase = (base: number, head: VersionRow) =>
    conflict(
      `Version ${base} is not the latest version (${head.number}). Redo the change on top of it.`
    );

  const nextConflict = (name: string) =>
    `The skill ${name} changed while you were committing. Redo the change on top of the latest version.`;

  /** A new skill with its first version. A person's is approved, an agent's run proposes it and owns it. */
  const create = async (
    principal: Principal,
    input: CreateInput
  ): Promise<{ skill: SkillRecord; version: VersionRecord }> => {
    const c = memberOf(principal, "skills.create", true);
    await ensureMigrated(principal);
    const parsed = createInputSchema.parse(input);
    assertSkillName(parsed.name);
    const files = await planWrites(parsed.files, new Map());
    const id = ulid();
    const version = await publish({
      assignTo: await ownerToAssign(c, parsed.name),
      caller: c,
      conflict: "A skill with this name already exists",
      event: "skill.created",
      files,
      id: ulid(),
      message: parsed.message,
      newSkill: { name: parsed.name, ownerAgentId: c.agentId },
      number: 1,
      parentNumber: null,
      previous: null,
      skill: { id, name: parsed.name },
    });
    return {
      skill: {
        createdAt: version.createdAt,
        id,
        latestApprovedVersion: version.status === "approved" ? 1 : null,
        latestVersion: 1,
        name: parsed.name,
        ownerAgentId: c.agentId,
        updatedAt: version.createdAt,
      },
      version,
    };
  };

  /**
   * One commit makes one new version from the base's tree. The base must be
   * the latest version that is not rejected, approved or proposed (the newest
   * one when all were rejected), else the commit is refused with a conflict, like a git non-fast-forward.
   */
  const commit = async (
    principal: Principal,
    input: CommitInput
  ): Promise<VersionRecord> => {
    const c = memberOf(principal, "skills.commit", true);
    await ensureMigrated(principal);
    const parsed = commitInputSchema.parse(input);
    const { head, parent, previous, skill, versions } = await headFor(
      c,
      parsed.skillId,
      "skills.commit"
    );
    if (head.number !== parsed.baseVersion) {
      throw staleBase(parsed.baseVersion, head);
    }
    const before = new Map(previous.map((file) => [file.path, file]));
    const tree = new Map(before);
    assertTreeShape(parsed.deletes.map((entry) => entry.path));
    for (const { path } of parsed.deletes) {
      if (!tree.delete(path)) {
        throw invalid(
          `Cannot delete "${path}", it is not in version ${head.number}`
        );
      }
    }
    assertTreeShape(parsed.writes.map((write) => write.path));
    const written = await planWrites(parsed.writes, before);
    const deleted = new Set(parsed.deletes.map((entry) => entry.path));
    for (const file of written) {
      if (deleted.has(file.path)) {
        throw invalid(`"${file.path}" is both written and deleted`);
      }
      tree.set(file.path, file);
    }
    return publish({
      caller: c,
      conflict: nextConflict(skill.name),
      event: "skill.committed",
      files: [...tree.values()].sort(byPath),
      id: ulid(),
      message: parsed.message,
      number: (versions[0]?.number ?? 0) + 1,
      parentNumber: parent,
      previous,
      skill: { id: skill.id, name: skill.name },
    });
  };

  /** A new version whose tree equals an older one. Made on the latest version, so history only grows. */
  const revert = async (
    principal: Principal,
    input: RevertInput
  ): Promise<VersionRecord> => {
    const c = memberOf(principal, "skills.commit", true);
    await ensureMigrated(principal);
    const parsed = revertInputSchema.parse(input);
    const { parent, previous, skill, versions } = await headFor(
      c,
      parsed.skillId,
      "skills.commit"
    );
    const target = await versionFor(c, skill.id, parsed.toVersion);
    if (target.status === "rejected") {
      throw invalid("A rejected version cannot be restored");
    }
    const tree = await treeOf(target.id);
    return publish({
      caller: c,
      conflict: nextConflict(skill.name),
      event: "skill.reverted",
      eventExtra: { restored: target.number },
      files: tree,
      id: ulid(),
      message: parsed.message ?? `Revert to version ${target.number}`,
      number: (versions[0]?.number ?? 0) + 1,
      parentNumber: parent,
      previous,
      skill: { id: skill.id, name: skill.name },
    });
  };

  // --- approving ---

  /** Settles a proposed version. Approving needs its base to be the latest approved version. */
  const decide = async (
    principal: Principal,
    input: DecideInput,
    outcome: "approved" | "rejected"
  ): Promise<VersionRecord> => {
    const action = outcome === "approved" ? "skills.approve" : "skills.reject";
    const c = peopleOf(principal, action);
    await ensureMigrated(principal);
    const parsed = decideInputSchema.parse(input);
    const skill = await skillFor(c, parsed.skillId);
    const versions = await versionsOf(skill.id);
    const target = versions.find(
      (version) => version.number === parsed.version
    );
    if (!target) {
      throw notFound();
    }
    assertCanSettle(versions, target, outcome);
    const now = clock.now().toISOString();
    const settled =
      outcome === "approved" ? [target] : proposalsBuiltOn(versions, target);
    await atomic([
      db
        .update(skillVersions)
        .set(
          outcome === "approved"
            ? { approvedAt: now, approvedBy: c.id, status: "approved" }
            : { status: "rejected" }
        )
        .where(
          and(
            eq(skillVersions.skillId, skill.id),
            inArray(
              skillVersions.number,
              settled.map((version) => version.number)
            ),
            eq(skillVersions.status, "proposed")
          )
        ),
      ...(outcome === "approved" && target.sourceCommitSha
        ? [
            db
              .update(skillSources)
              .set({ commitSha: target.sourceCommitSha, updatedAt: now })
              .where(eq(skillSources.skillId, skill.id)),
          ]
        : []),
      ...settled.map((version) =>
        eventStatement(
          c,
          outcome === "approved" ? "skill.approved" : "skill.rejected",
          {
            name: skill.name,
            skillId: skill.id,
            version: version.number,
            ...(version === target ? {} : { rejectedWith: target.number }),
          },
          version.authorKind === "agent" ? version.authorId : null
        )
      ),
    ]);
    return toVersionRecord({
      ...target,
      ...(outcome === "approved"
        ? { approvedAt: now, approvedBy: c.id, status: "approved" as const }
        : { status: "rejected" as const }),
    });
  };

  const approve = (principal: Principal, input: DecideInput) =>
    decide(principal, input, "approved");

  const reject = (principal: Principal, input: DecideInput) =>
    decide(principal, input, "rejected");

  // --- assigning ---

  const assignmentFor = async (
    workspaceId: string,
    agentId: string,
    skillId: string
  ) => {
    const [row] = await db
      .select()
      .from(skillAssignments)
      .where(
        and(
          eq(skillAssignments.workspaceId, workspaceId),
          eq(skillAssignments.agentId, agentId),
          eq(skillAssignments.skillId, skillId)
        )
      )
      .limit(1);
    return row ?? null;
  };

  const requireAgent = async (c: Caller, agentId: string): Promise<void> => {
    if (!(await findAgent(db, { id: agentId, workspaceId: c.workspaceId }))) {
      throw new ServiceError("not_found", "Agent not found");
    }
  };

  const pinnedNumber = async (
    pinnedVersionId: string | null
  ): Promise<number | null> => {
    if (pinnedVersionId === null) {
      return null;
    }
    const [row] = await db
      .select({ number: skillVersions.number })
      .from(skillVersions)
      .where(eq(skillVersions.id, pinnedVersionId))
      .limit(1);
    return row?.number ?? null;
  };

  /** Hands the agent a skill, following the latest approved version. Assigning again changes nothing. */
  const assign = async (
    principal: Principal,
    input: AssignInput
  ): Promise<AssignmentRecord> => {
    const c = peopleOf(principal, "skills.assign");
    await ensureMigrated(principal);
    const parsed = assignInputSchema.parse(input);
    await requireAgent(c, parsed.agentId);
    const skill = await skillFor(c, parsed.skillId);
    const existing = await assignmentFor(
      c.workspaceId,
      parsed.agentId,
      skill.id
    );
    if (existing) {
      return {
        agentId: existing.agentId,
        pinnedVersion: await pinnedNumber(existing.pinnedVersionId),
        skillId: existing.skillId,
      };
    }
    if (await carriesName(parsed.agentId, skill.name)) {
      throw conflict(`The agent already carries a skill named ${skill.name}`);
    }
    await atomic([
      db.insert(skillAssignments).values({
        agentId: parsed.agentId,
        createdAt: clock.now().toISOString(),
        pinnedVersionId: null,
        skillId: skill.id,
        workspaceId: c.workspaceId,
      }),
      eventStatement(
        c,
        "skill.assigned",
        { agentId: parsed.agentId, name: skill.name, skillId: skill.id },
        parsed.agentId
      ),
    ]);
    return { agentId: parsed.agentId, pinnedVersion: null, skillId: skill.id };
  };

  /** Takes the skill away from the agent. Does nothing when it was not assigned. */
  const unassign = async (
    principal: Principal,
    input: AssignInput
  ): Promise<void> => {
    const c = peopleOf(principal, "skills.unassign");
    await ensureMigrated(principal);
    const parsed = assignInputSchema.parse(input);
    await requireAgent(c, parsed.agentId);
    const skill = await skillFor(c, parsed.skillId);
    if (!(await assignmentFor(c.workspaceId, parsed.agentId, skill.id))) {
      return;
    }
    await atomic([
      db
        .delete(skillAssignments)
        .where(
          and(
            eq(skillAssignments.agentId, parsed.agentId),
            eq(skillAssignments.skillId, skill.id)
          )
        ),
      eventStatement(
        c,
        "skill.unassigned",
        { agentId: parsed.agentId, name: skill.name, skillId: skill.id },
        parsed.agentId
      ),
    ]);
  };

  /** Pins an assignment to an approved version, or with null back to the latest approved one. */
  const pin = async (
    principal: Principal,
    input: PinInput
  ): Promise<AssignmentRecord> => {
    const c = peopleOf(principal, "skills.pin");
    await ensureMigrated(principal);
    const parsed = pinInputSchema.parse(input);
    await requireAgent(c, parsed.agentId);
    const skill = await skillFor(c, parsed.skillId);
    if (!(await assignmentFor(c.workspaceId, parsed.agentId, skill.id))) {
      throw notFound();
    }
    let versionId: string | null = null;
    if (parsed.version !== null) {
      const version = await versionFor(c, skill.id, parsed.version);
      if (version.status !== "approved") {
        throw invalid("Only an approved version can be pinned");
      }
      versionId = version.id;
    }
    await atomic([
      db
        .update(skillAssignments)
        .set({ pinnedVersionId: versionId })
        .where(
          and(
            eq(skillAssignments.agentId, parsed.agentId),
            eq(skillAssignments.skillId, skill.id)
          )
        ),
      eventStatement(
        c,
        "skill.pinned",
        {
          agentId: parsed.agentId,
          name: skill.name,
          skillId: skill.id,
          version: parsed.version,
        },
        parsed.agentId
      ),
    ]);
    return {
      agentId: parsed.agentId,
      pinnedVersion: parsed.version,
      skillId: skill.id,
    };
  };

  // --- deleting ---

  /** Runs in these states may still read the skill. */
  const LIVE_RUN_STATUSES: RunStatus[] = [
    "queued",
    "offered",
    "running",
    "waiting",
  ];

  /** The hashes among `hashes` that no remaining version file holds. */
  const unusedHashes = async (hashes: readonly string[]): Promise<string[]> => {
    const used = new Set<string>();
    for (const part of chunks([...hashes], HASHES_PER_QUERY)) {
      // biome-ignore lint/performance/noAwaitInLoops: Chunks keep each query under the D1 parameter limit.
      const rows = await db
        .select({ hash: skillVersionFiles.hash })
        .from(skillVersionFiles)
        .where(inArray(skillVersionFiles.hash, part));
      for (const row of rows) {
        used.add(row.hash);
      }
    }
    return hashes.filter((hash) => !used.has(hash));
  };

  /**
   * Deletes a skill with its versions, files, assignments and upstream source.
   * People only. Refused while a run of an agent that owns or carries the skill
   * is queued, running or waiting, because that run may be reading it. The
   * file bytes go from blob storage when no other version holds them.
   */
  const remove = async (
    principal: Principal,
    input: z.input<typeof skillRefSchema>
  ): Promise<void> => {
    const c = peopleOf(principal, "skills.delete");
    await ensureMigrated(principal);
    const parsed = skillRefSchema.parse(input);
    const skill = await skillFor(c, parsed.skillId);
    const carriers = await db
      .select({ agentId: skillAssignments.agentId })
      .from(skillAssignments)
      .where(eq(skillAssignments.skillId, skill.id));
    const agentIds = [
      ...new Set([
        ...carriers.map((row) => row.agentId),
        ...(skill.ownerAgentId ? [skill.ownerAgentId] : []),
      ]),
    ];
    if (agentIds.length > 0) {
      const [live] = await db
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            inArray(runs.agentId, agentIds),
            inArray(runs.status, LIVE_RUN_STATUSES)
          )
        )
        .limit(1);
      if (live) {
        throw conflict(
          `A run is using ${skill.name}. Delete it when the run has finished, or cancel the run first.`
        );
      }
    }
    const files = await db
      .select({ hash: skillVersionFiles.hash })
      .from(skillVersionFiles)
      .innerJoin(
        skillVersions,
        eq(skillVersions.id, skillVersionFiles.versionId)
      )
      .where(eq(skillVersions.skillId, skill.id));
    const hashes = [...new Set(files.map((file) => file.hash))];
    const ofSkill = db
      .select({ id: skillVersions.id })
      .from(skillVersions)
      .where(eq(skillVersions.skillId, skill.id));
    await atomic([
      db.delete(skillAssignments).where(eq(skillAssignments.skillId, skill.id)),
      db
        .delete(skillVersionFiles)
        .where(inArray(skillVersionFiles.versionId, ofSkill)),
      db.delete(skillVersions).where(eq(skillVersions.skillId, skill.id)),
      db.delete(skillSources).where(eq(skillSources.skillId, skill.id)),
      db.delete(skills).where(eq(skills.id, skill.id)),
      eventStatement(
        c,
        "skill.deleted",
        { name: skill.name, skillId: skill.id },
        skill.ownerAgentId
      ),
    ]);
    const orphaned = await unusedHashes(hashes);
    await Promise.all(orphaned.map((hash) => blobs.remove(blobKey(hash))));
  };

  /** The version an assignment resolves to: its pin, else the latest approved one. Null when there is none. */
  const resolvedVersion = async (assignment: {
    pinnedVersionId: string | null;
    skillId: string;
  }): Promise<VersionRow | null> => {
    const [row] = await db
      .select()
      .from(skillVersions)
      .where(
        assignment.pinnedVersionId === null
          ? and(
              eq(skillVersions.skillId, assignment.skillId),
              eq(skillVersions.status, "approved")
            )
          : eq(skillVersions.id, assignment.pinnedVersionId)
      )
      .orderBy(desc(skillVersions.number))
      .limit(1);
    return row ?? null;
  };

  /**
   * The skills an agent carries, each at its pinned version or the latest
   * approved one, as a list of files, ordered by name. A skill with no
   * approved version yet is left out. A run may ask only for its own agent.
   */
  const forAgent = async (
    principal: Principal,
    agentId: string,
    options: ForAgentOptions = {}
  ): Promise<ResolvedSkill[]> => {
    const c = memberOf(principal, "skills.read", false);
    if (c.agentId !== null && c.agentId !== agentId) {
      throw new ForbiddenError("skills.read");
    }
    await ensureMigrated(principal);
    await requireAgent(c, agentId);
    const { paths, withContents: contents } =
      forAgentOptionsSchema.parse(options);
    const only = paths === undefined ? null : new Set(paths);
    const rows = await db
      .select({
        name: skills.name,
        pinnedVersionId: skillAssignments.pinnedVersionId,
        skillId: skills.id,
      })
      .from(skillAssignments)
      .innerJoin(skills, eq(skills.id, skillAssignments.skillId))
      .where(
        and(
          eq(skillAssignments.workspaceId, c.workspaceId),
          eq(skillAssignments.agentId, agentId),
          eq(skills.deleted, false)
        )
      )
      .orderBy(asc(skills.name));
    // Resolving a skill costs a version and a tree query, so skills outside `paths` are skipped first.
    const candidates =
      paths === undefined
        ? rows
        : rows.filter((row) =>
            paths.some((path) => path.startsWith(`${row.name}/`))
          );
    const resolved = await Promise.all(
      candidates.map(async (row): Promise<ResolvedSkill | null> => {
        const version = await resolvedVersion(row);
        if (!version) {
          return null;
        }
        const tree = await treeOf(version.id);
        const wanted =
          only === null
            ? tree
            : tree.filter((file) => only.has(`${row.name}/${file.path}`));
        if (only !== null && wanted.length === 0) {
          return null;
        }
        return {
          files: await asRecords(wanted, contents),
          name: row.name,
          pinned: row.pinnedVersionId !== null,
          skillId: row.skillId,
          version: version.number,
        };
      })
    );
    return resolved.filter((skill) => skill !== null);
  };

  /**
   * Every assignment in the workspace, so a page can show who carries which
   * skill. A run sees only its own agent's.
   */
  const assignments = async (
    principal: Principal
  ): Promise<AssignmentRecord[]> => {
    const c = memberOf(principal, "skills.read", false);
    await ensureMigrated(principal);
    const rows = await db
      .select({
        agentId: skillAssignments.agentId,
        pinnedVersion: skillVersions.number,
        skillId: skillAssignments.skillId,
      })
      .from(skillAssignments)
      .innerJoin(skills, eq(skills.id, skillAssignments.skillId))
      .leftJoin(
        skillVersions,
        eq(skillVersions.id, skillAssignments.pinnedVersionId)
      )
      .where(
        and(
          eq(skillAssignments.workspaceId, c.workspaceId),
          eq(skills.deleted, false),
          c.agentId === null
            ? undefined
            : eq(skillAssignments.agentId, c.agentId)
        )
      )
      .orderBy(asc(skillAssignments.agentId), asc(skillAssignments.skillId));
    return rows;
  };

  /** The versions waiting for a decision, newest first. A run sees only its own agent's. */
  const proposals = async (principal: Principal): Promise<VersionRecord[]> => {
    const c = memberOf(principal, "skills.read", false);
    await ensureMigrated(principal);
    const rows = await db
      .select({ version: skillVersions })
      .from(skillVersions)
      .innerJoin(skills, eq(skills.id, skillVersions.skillId))
      .where(
        and(
          eq(skillVersions.workspaceId, c.workspaceId),
          eq(skillVersions.status, "proposed"),
          eq(skills.deleted, false)
        )
      )
      .orderBy(desc(skillVersions.createdAt), desc(skillVersions.number));
    return rows
      .map((row) => row.version)
      .filter((version) => visibleTo(c, version))
      .map(toVersionRecord);
  };

  const sourceOf = async (skillId: string) =>
    (
      await db
        .select()
        .from(skillSources)
        .where(eq(skillSources.skillId, skillId))
        .limit(1)
    )[0] ?? null;

  const githubFetcher = () => {
    if (!github) {
      throw invalid("GitHub import is not set up");
    }
    return github;
  };

  const githubFiles = async (
    source: { repoUrl: string; path: string | null },
    commitSha: string
  ): Promise<PlannedFile[]> => {
    try {
      const files = await githubFetcher().tree({
        ...source,
        commitSha,
        githubToken,
      });
      return await Promise.all(
        files.map(async (file) => ({
          ...file,
          hash: await sha256Hex(file.bytes),
          size: file.bytes.byteLength,
        }))
      );
    } catch (error) {
      throw invalid(
        error instanceof Error ? error.message : "GitHub skill fetch failed"
      );
    }
  };

  const resolveGithub = async (source: { repoUrl: string; ref: string }) => {
    try {
      return await githubFetcher().resolve({ ...source, githubToken });
    } catch (error) {
      throw invalid(
        error instanceof Error ? error.message : "GitHub commit lookup failed"
      );
    }
  };

  const importGithub = async (
    principal: Principal,
    input: ImportGithubInput
  ) => {
    const c = memberOf(principal, "skills.import", true);
    githubFetcher();
    const location = githubLocation(input);
    assertSkillName(location.name);
    await ensureMigrated(principal);
    const commitSha = await resolveGithub(location);
    const files = await githubFiles(location, commitSha);
    const [existing] = await db
      .select({ id: skills.id })
      .from(skills)
      .where(
        and(
          eq(skills.workspaceId, c.workspaceId),
          eq(skills.name, location.name),
          c.agentId === null
            ? isNull(skills.ownerAgentId)
            : eq(skills.ownerAgentId, c.agentId)
        )
      )
      .limit(1);
    if (existing && c.kind === "agent") {
      // A proposal can't carry a new location, so an agent keeps the one it has.
      const current = await sourceOf(existing.id);
      if (
        current &&
        (current.repoUrl !== location.repoUrl ||
          current.path !== location.path ||
          current.ref !== location.ref)
      ) {
        throw invalid("An agent can't change a skill's GitHub source");
      }
    }
    const publication = {
      message: "Imported from GitHub",
      source: {
        commitSha,
        path: location.path,
        ref: location.ref,
        repoUrl: location.repoUrl,
      },
      sourceCommitSha: commitSha,
    };
    const version = existing
      ? await importOver(c, existing.id, files, publication)
      : await importNew(c, location.name, files, publication);
    return { created: !existing, name: location.name, version };
  };

  const importUpdate = async (principal: Principal, skillId: string) => {
    const c = memberOf(principal, "skills.import", true);
    githubFetcher();
    await ensureMigrated(principal);
    const skill = await skillFor(c, skillRefSchema.parse({ skillId }).skillId);
    // Check ownership before any upstream request, as archive imports do.
    await headFor(c, skill.id, "skills.import");
    const source = await sourceOf(skill.id);
    if (
      !source?.latestCommitSha ||
      source.latestCommitSha === source.commitSha
    ) {
      throw invalid("No GitHub update available");
    }
    const files = await githubFiles(source, source.latestCommitSha);
    return importOver(c, skill.id, files, {
      message: "Proposed update from GitHub",
      sourceCommitSha: source.latestCommitSha,
      status: "proposed",
    });
  };

  const checkUpdates = async (
    principal: Principal,
    input: { limit: number }
  ) => {
    if (principal.kind !== "system") {
      throw new ForbiddenError("skills.checkUpdates");
    }
    authorize(principal, "skills.checkUpdates", {
      kind: SKILL_KIND,
      workspaceId: "*",
    });
    const { limit } = z
      .strictObject({ limit: z.int().min(1).max(1000) })
      .parse(input);
    const rows = await db
      .select({ name: skills.name, source: skillSources })
      .from(skillSources)
      .innerJoin(skills, eq(skills.id, skillSources.skillId))
      .where(
        and(eq(skillSources.provider, "github"), eq(skills.deleted, false))
      )
      .orderBy(asc(skillSources.checkedAt), asc(skillSources.skillId))
      .limit(limit);
    const failures: { skillId: string; message: string }[] = [];
    let available = 0;
    for (const { source, name } of rows) {
      const now = clock.now().toISOString();
      let resolved: string;
      try {
        // biome-ignore lint/performance/noAwaitInLoops: Keep scheduled checks bounded and stamp failures before continuing.
        resolved = await resolveGithub(source);
      } catch (error) {
        await atomic([
          db
            .update(skillSources)
            .set({ checkedAt: now })
            .where(eq(skillSources.skillId, source.skillId)),
        ]);
        failures.push({
          message:
            error instanceof Error
              ? error.message
              : "GitHub update check failed",
          skillId: source.skillId,
        });
        continue;
      }
      // latestCommitSha is the last notified commit, retained when upstream returns to the pin.
      const changed = hasGithubUpdate(
        source.commitSha,
        source.latestCommitSha,
        resolved
      );
      const c: Caller = {
        agentId: null,
        id: "system",
        kind: "system",
        runId: null,
        workspaceId: source.workspaceId,
      };
      await atomic([
        db
          .update(skillSources)
          .set({
            checkedAt: now,
            ...(changed ? { latestCommitSha: resolved, updatedAt: now } : {}),
          })
          .where(eq(skillSources.skillId, source.skillId)),
        ...(changed
          ? [
              eventStatement(c, "skill.update_available", {
                commitSha: source.commitSha,
                latestCommitSha: resolved,
                name,
                skillId: source.skillId,
              }),
            ]
          : []),
      ]);
      if (changed) {
        available += 1;
      }
    }
    return { available, checked: rows.length, failures };
  };

  // --- archives ---

  const IMPORT_MESSAGE = "Imported from a .skill file";

  /** A new skill from an archive. */
  const importNew = async (
    c: Caller,
    name: string,
    files: PlannedFile[],
    githubPublication: Partial<
      Pick<Publication, "source" | "sourceCommitSha" | "status" | "message">
    > = {}
  ): Promise<VersionRecord> =>
    publish({
      assignTo: await ownerToAssign(c, name),
      caller: c,
      conflict: "A skill with this name already exists",
      event: "skill.imported",
      eventExtra: { created: true },
      files,
      id: ulid(),
      message: IMPORT_MESSAGE,
      newSkill: { name, ownerAgentId: c.agentId },
      number: 1,
      parentNumber: null,
      previous: null,
      skill: { id: ulid(), name },
      ...githubPublication,
    });

  /** A new version of an existing skill that holds exactly the archive's tree. */
  const importOver = async (
    c: Caller,
    skillId: string,
    files: PlannedFile[],
    githubPublication: Partial<
      Pick<Publication, "source" | "sourceCommitSha" | "status" | "message">
    > = {}
  ): Promise<VersionRecord> => {
    const { parent, previous, skill, versions } = await headFor(
      c,
      skillId,
      "skills.import"
    );
    if (
      githubPublication.sourceCommitSha &&
      headOf(versions)?.sourceCommitSha === githubPublication.sourceCommitSha &&
      sameTree(previous, files)
    ) {
      throw invalid("Nothing changed from the base version");
    }
    const before = new Map(previous.map((file) => [file.path, file.hash]));
    return publish({
      caller: c,
      conflict: nextConflict(skill.name),
      event: "skill.imported",
      eventExtra: { created: false },
      files: files.map((file) =>
        before.get(file.path) === file.hash
          ? { ...file, bytes: undefined }
          : file
      ),
      id: ulid(),
      message: IMPORT_MESSAGE,
      number: (versions[0]?.number ?? 0) + 1,
      parentNumber: parent,
      previous,
      skill: { id: skill.id, name: skill.name },
      ...githubPublication,
    });
  };

  /**
   * Imports a `.skill` archive: a zip with one top-level folder holding
   * SKILL.md and the other files. The folder name is the skill's name. A skill
   * of that name that the caller owns (the people's, or the agent's own) gets
   * a new version holding exactly the archive's tree, else a new skill is made.
   */
  const importSkillArchive = async (
    principal: Principal,
    zip: Uint8Array
  ): Promise<{ created: boolean; name: string; version: VersionRecord }> => {
    const c = memberOf(principal, "skills.import", true);
    await ensureMigrated(principal);
    if (zip.byteLength > ARCHIVE_MAX_BYTES) {
      throw invalid("The archive is too big");
    }
    const unpacked = unpackArchive(zip, {
      maxBytes: SKILLS_MAX_BYTES,
      maxFiles: SKILLS_MAX_FILES,
    });
    const name = unpacked.folder;
    assertSkillName(name);
    const [existing] = await db
      .select({ id: skills.id })
      .from(skills)
      .where(
        and(
          eq(skills.workspaceId, c.workspaceId),
          eq(skills.name, name),
          c.agentId === null
            ? isNull(skills.ownerAgentId)
            : eq(skills.ownerAgentId, c.agentId)
        )
      )
      .limit(1);
    const files = await Promise.all(
      unpacked.files.map(
        async (file): Promise<PlannedFile> => ({
          bytes: file.bytes,
          executable: file.executable,
          hash: await sha256Hex(file.bytes),
          path: file.path,
          size: file.bytes.byteLength,
        })
      )
    );
    const version = existing
      ? await importOver(c, existing.id, files)
      : await importNew(c, name, files);
    return { created: !existing, name, version };
  };

  /** A version as a `.skill` archive: a zip with one folder named after the skill. */
  const exportSkillArchive = async (
    principal: Principal,
    input: ExportInput
  ): Promise<{ bytes: Uint8Array; filename: string }> => {
    const c = memberOf(principal, "skills.read", false);
    await ensureMigrated(principal);
    const parsed = exportInputSchema.parse(input);
    const skill = await skillFor(c, parsed.skillId);
    const version = await versionFor(c, skill.id, parsed.version);
    const files = await withContents(await treeOf(version.id));
    return {
      bytes: packArchive(
        skill.name,
        files.map((file) => ({
          bytes: file.content ?? new Uint8Array(),
          executable: file.executable,
          path: file.path,
        })),
        new Date(version.createdAt)
      ),
      filename: `${skill.name}.skill`,
    };
  };

  return {
    approve,
    assign,
    assignments,
    checkUpdates,
    commit,
    create,
    diff,
    exportSkillArchive,
    forAgent,
    importGithub,
    importSkillArchive,
    importUpdate,
    list,
    log,
    migrateLibrary,
    pin,
    proposals,
    readFile,
    reject,
    remove,
    revert,
    show,
    unassign,
  };
};

export type SkillsStoreService = ReturnType<typeof createSkillsStoreService>;
