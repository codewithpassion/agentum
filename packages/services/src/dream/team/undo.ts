// Undo of a team dream, the same way as an agent's: every file it wrote goes
// back to the bytes it had before (member files, team files, the digest), in
// one library call, and refuses when anyone has written those files since.
// The digest has no row of its own. The dream writes it last, so the run's
// result version is the digest's version exactly when it wrote one.
import type { Database } from "@repo/db";
import type { Atomic, Statement } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import { dreamRuns } from "@repo/db/schema/dreams";
import { memoryChanges } from "@repo/db/schema/memory";
import { and, asc, eq, inArray } from "drizzle-orm";
import { ServiceError } from "../../errors.ts";
import { teamMemoryFolderOf } from "../../library/memory-paths.ts";
import {
  buildIndex,
  type MemoryFiles,
  parseMemoryFile,
  serializeMemoryFile,
} from "../../memory/codec.ts";
import {
  commitFolderFiles,
  type FolderWrite,
  type LoadedMemory,
  loadMemory,
  type MemoryLibrary,
} from "../../memory/files.ts";
import {
  loadTeamFolder,
  readTeamDigestFile,
  TEAM_DIGEST_FILE,
} from "../../memory/team.ts";
import type { Clock } from "../../runs/types.ts";
import { type RunRow, toRun } from "../rows.ts";
import { teamDreamPrincipal } from "./team.ts";

const INDEX = "index.md";

export interface TeamUndoDeps {
  atomic: Atomic;
  clock: Clock;
  db: Database;
  library: MemoryLibrary;
}

const staleMemory = () =>
  new ServiceError(
    "conflict",
    "Memory changed after this dream ran, so it cannot be undone as a whole. Forget or edit the notes you do not want."
  );

const notesIn = (files: MemoryFiles) =>
  Object.entries(files).flatMap(([path, text]) => {
    if (path === INDEX) {
      return [];
    }
    const parsed = parseMemoryFile(path, text);
    return parsed.ok ? parsed.notes : [];
  });

type Principal = ReturnType<typeof teamDreamPrincipal>;
type Row = typeof memoryChanges.$inferSelect;

interface Folder {
  folder: string;
  loaded: LoadedMemory;
  /** The note files the dream wrote here, relative to the folder. */
  touched: Set<string>;
}

/** The slug of each member agent the rows name. */
const slugsOf = async (
  db: Database,
  workspaceId: string,
  rows: readonly Row[]
): Promise<Map<string, string>> => {
  const agentIds = [
    ...new Set(rows.flatMap((row) => (row.agentId ? [row.agentId] : []))),
  ];
  if (agentIds.length === 0) {
    return new Map();
  }
  const found = await db
    .select({ id: agents.id, slug: agents.slug })
    .from(agents)
    .where(
      and(eq(agents.workspaceId, workspaceId), inArray(agents.id, agentIds))
    );
  return new Map(found.map((agent) => [agent.id, agent.slug] as const));
};

/** The newest version of each file the dream wrote must still be the dream's. */
const ensureUntouched = async (
  library: MemoryLibrary,
  principal: Principal,
  checks: readonly { path: string; versionId: string }[]
): Promise<void> => {
  const latest = await Promise.all(
    checks.map(
      async (check) => (await library.versions(principal, check.path))[0]
    )
  );
  if (
    latest.some((version, index) => version?.id !== checks[index]?.versionId)
  ) {
    throw staleMemory();
  }
};

/** What each file held before the dream, by library path. */
const textsBefore = async (
  library: MemoryLibrary,
  principal: Principal,
  versionIds: readonly string[]
): Promise<Map<string, string>> => {
  const decoder = new TextDecoder();
  const read = await Promise.all(
    versionIds.map((id) => library.readVersion(principal, id))
  );
  return new Map(
    read.map(({ bytes, version }) => [version.path, decoder.decode(bytes)])
  );
};

/** The note files each touched folder goes back to, with its index rebuilt, as library writes. */
const restoreWrites = (
  folders: ReadonlyMap<string, Folder>,
  before: ReadonlyMap<string, string>
): FolderWrite[] =>
  [...folders.values()].flatMap(({ folder, loaded, touched }) => {
    const next: MemoryFiles = { ...loaded.files };
    for (const path of touched) {
      // A file the dream made has no earlier version: it goes back to empty.
      next[path] =
        before.get(`${folder}/${path}`) ?? serializeMemoryFile(path, []);
    }
    if (touched.size > 0) {
      next[INDEX] = buildIndex(notesIn(next));
    }
    return Object.entries(next).flatMap(([path, text]) =>
      text === loaded.texts[path]
        ? []
        : [{ ifEtag: loaded.etags[path], path: `${folder}/${path}`, text }]
    );
  });

export const createTeamUndo = ({
  atomic,
  clock,
  db,
  library,
}: TeamUndoDeps) => {
  /** Each folder the rows touch, read as it is now. */
  const openFolders = async (
    principal: Principal,
    team: { folderPath: string; id: string },
    rows: readonly Row[],
    slugs: ReadonlyMap<string, string>
  ): Promise<Map<string, Folder>> => {
    const teamFolder = teamMemoryFolderOf(team.folderPath);
    const wanted = new Map<
      string,
      { slug: string | null; touched: Set<string> }
    >([[teamFolder, { slug: null, touched: new Set() }]]);
    for (const row of rows) {
      const slug = row.agentId ? (slugs.get(row.agentId) ?? null) : null;
      const folder = slug ? `agents/${slug}/memory` : teamFolder;
      const entry = wanted.get(folder) ?? { slug, touched: new Set<string>() };
      entry.touched.add(`${row.kind}.md`);
      wanted.set(folder, entry);
    }
    const opened = await Promise.all(
      [...wanted].map(async ([folder, { slug, touched }]) => {
        const loaded =
          slug === null
            ? await loadTeamFolder(library, principal, team.folderPath)
            : await loadMemory(library, principal, slug, null);
        return [folder, { folder, loaded, touched }] as const;
      })
    );
    return new Map(opened);
  };

  const undo = async (
    run: RunRow,
    team: { folderPath: string | null; id: string; workspaceId: string },
    userId: string
  ): Promise<void> => {
    if (run.status !== "done" || run.resultVersion === null) {
      throw new ServiceError(
        "conflict",
        "Only a dream that changed memory can be undone"
      );
    }
    if (team.folderPath === null) {
      throw new ServiceError("invalid", "This team has no memory folder");
    }
    const { folderPath } = team;
    const principal = teamDreamPrincipal(team);
    const teamFolder = teamMemoryFolderOf(folderPath);
    const digestPath = `${teamFolder}/${TEAM_DIGEST_FILE}`;
    const rows = await db
      .select()
      .from(memoryChanges)
      .where(
        and(
          eq(memoryChanges.dreamRunId, run.id),
          eq(memoryChanges.status, "applied")
        )
      )
      .orderBy(asc(memoryChanges.id));
    const slugs = await slugsOf(db, team.workspaceId, rows);
    const pathOf = (row: Row): string => {
      const slug = row.agentId ? slugs.get(row.agentId) : undefined;
      return `${slug ? `agents/${slug}/memory` : teamFolder}/${row.kind}.md`;
    };
    const { version: resultOf } = await library.readVersion(
      principal,
      run.resultVersion
    );
    const wroteDigest = resultOf.path === digestPath;
    await ensureUntouched(library, principal, [
      ...rows.flatMap((row) =>
        row.libraryVersionId === null
          ? []
          : [{ path: pathOf(row), versionId: row.libraryVersionId }]
      ),
      ...(wroteDigest
        ? [{ path: digestPath, versionId: run.resultVersion }]
        : []),
    ]);
    const before = await textsBefore(
      library,
      principal,
      toRun(run).baseVersion
    );
    const folders = await openFolders(
      principal,
      { folderPath, id: team.id },
      rows,
      slugs
    );
    const writes = restoreWrites(folders, before);
    if (wroteDigest) {
      const current = await readTeamDigestFile(library, principal, folderPath);
      writes.push({
        ifEtag: current === null ? undefined : current.etag,
        path: digestPath,
        text: before.get(digestPath) ?? "",
      });
    }
    const now = clock.now().toISOString();
    const statements = (): Statement[] => [
      db
        .update(memoryChanges)
        .set({ decidedAt: now, decidedBy: userId, status: "undone" })
        .where(
          and(
            eq(memoryChanges.dreamRunId, run.id),
            eq(memoryChanges.status, "applied")
          )
        ),
      db
        .update(dreamRuns)
        .set({
          diary: `${run.diary}\nThis dream was undone.`.trim(),
          status: "undone",
        })
        .where(and(eq(dreamRuns.id, run.id), eq(dreamRuns.status, "done"))),
    ];
    if (writes.length === 0) {
      await atomic(statements());
      return;
    }
    await commitFolderFiles({
      library,
      principal,
      statements,
      writes,
    });
  };

  return { undo };
};
