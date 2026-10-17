/**
 * An agent's skills, read from the workspace library (S.1). A skill is a folder
 * under `skills/<agentId>/` (the agent's own) or `skills/_shared/` (every agent
 * of the workspace). An own skill with the same name replaces the shared one
 * whole. Only a run reads them, and only its own agent's skills.
 */
import {
  SKILLS_MAX_BYTES,
  SKILLS_MAX_FILES,
  type SkillFile,
} from "@repo/protocol/skills";
import type { AgentsService } from "./agents.ts";
import { ForbiddenError } from "./authz.ts";
import { isServiceError, ServiceError } from "./errors.ts";
import { readSkillMeta } from "./library/skill-file.ts";
import type { LibraryEntry, LibraryService } from "./library.ts";
import type { Principal } from "./workspaces.ts";

type RunPrincipal = Extract<Principal, { kind: "run" }>;

export type SkillsLibrary = Pick<
  LibraryService,
  "list" | "read" | "remove" | "stat" | "write"
>;

export type SkillScope = "agent" | "shared";

/** One skill folder for the Skills tab. Name and description are null when the file has a problem. */
export interface SkillCatalogEntry {
  description: string | null;
  folder: string;
  name: string | null;
  path: string;
  problem: string | null;
  scope: SkillScope;
}

const SKILLS_DIR = "skills";
const SHARED_DIR = "_shared";
const SKILL_FILE = "SKILL.md";
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_NAME_MAX = 64;
const BAD_NAME =
  "Skill names use lowercase letters, digits and single hyphens, up to 64 characters";
const NAME_TAKEN = "A skill with this name already exists";
const MISSING = "SKILL.md is missing";
const NOT_UTF8 = "SKILL.md is not valid UTF-8 text";
const TEMPLATE = (name: string) => `---
name: ${name}
description: Describe what this skill does and when the agent should use it.
---

# ${name}

Write the instructions for the agent here.
`;
const CONTROL_CHARS = /\p{Cc}/u;
const TOO_BIG = "Skills are limited to 200 files and 5 MB";

const notFound = () => new ServiceError("not_found", "Not found");
const invalid = (message: string) => new ServiceError("invalid", message);

/** A run may read its own skills. Other principals are refused, and another run gets not_found. */
const requireRun = (
  principal: Principal,
  action: string,
  runId: string
): RunPrincipal => {
  if (principal.kind !== "run") {
    throw new ForbiddenError(action);
  }
  if (principal.runId !== runId) {
    throw notFound();
  }
  return principal;
};

/** Refuses anything that could climb out of the skill folder, before the library sees it. */
const relativeSegments = (path: string, minSegments = 2): string[] => {
  if (path.startsWith("/") || path.startsWith("\\")) {
    throw invalid("Skill path must be relative");
  }
  if (CONTROL_CHARS.test(path)) {
    throw invalid("Skill path contains control characters");
  }
  const segments = path.split("/");
  if (segments.length < minSegments) {
    throw invalid("Skill path needs a skill folder and a file");
  }
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw invalid("Skill path has an empty or dot segment");
    }
  }
  return segments;
};

/** A file path under a skill folder, checked and joined for the library. */
const filePath = (path: string): string => {
  if (path.includes("\\")) {
    throw invalid("Skill path must use / and no backslashes");
  }
  return relativeSegments(path, 1).join("/");
};

/** A folder the walk still has to visit, and the path its entries get. */
interface Folder {
  dir: string;
  path: string;
}

/** Visits the files under each folder, one folder at a time. `onFile` may throw to stop the walk. */
const walkFiles = async (
  library: SkillsLibrary,
  principal: Principal,
  start: Folder[],
  onFile: (file: SkillFile) => void
): Promise<void> => {
  const pending = [...start];
  for (let next = pending.pop(); next; next = pending.pop()) {
    // biome-ignore lint/performance/noAwaitInLoops: one folder at a time keeps the cap exact
    const entries = await library.list(principal, next.dir);
    for (const entry of entries) {
      const name = lastSegment(entry.path);
      const path = next.path === "" ? name : `${next.path}/${name}`;
      if (entry.kind === "dir") {
        pending.push({ dir: entry.path, path });
      } else if (entry.etag !== null) {
        onFile({ etag: entry.etag, path, size: entry.size });
      }
    }
  }
};

const requireSkillName = (name: string) => {
  if (name.length > SKILL_NAME_MAX || !SKILL_NAME.test(name)) {
    throw invalid(BAD_NAME);
  }
};

/** The library lists a missing folder as not_found. That means an empty root. */
const listOrEmpty = async (
  library: SkillsLibrary,
  principal: Principal,
  dir: string
) => {
  try {
    return await library.list(principal, dir);
  } catch (error) {
    if (isServiceError(error) && error.code === "not_found") {
      return [];
    }
    throw error;
  }
};

/** Whether anything is at `path`. A missing path is free. */
const exists = async (
  library: SkillsLibrary,
  principal: Principal,
  path: string
): Promise<boolean> => {
  try {
    await library.stat(principal, path);
    return true;
  } catch (error) {
    if (isServiceError(error) && error.code === "not_found") {
      return false;
    }
    throw error;
  }
};

const isFolder = async (
  library: SkillsLibrary,
  principal: Principal,
  path: string
): Promise<boolean> => {
  try {
    return (await library.stat(principal, path)).kind === "dir";
  } catch (error) {
    if (isServiceError(error) && error.code === "not_found") {
      return false;
    }
    throw error;
  }
};

const lastSegment = (path: string): string =>
  path.slice(path.lastIndexOf("/") + 1);

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** The catalog entry for one skill folder, with its problem when the file breaks a rule. */
const catalogEntry = async (
  library: SkillsLibrary,
  principal: Principal,
  scope: SkillScope,
  root: string,
  folder: string
): Promise<SkillCatalogEntry> => {
  const path = `${root}/${folder}/${SKILL_FILE}`;
  const base = { description: null, folder, name: null, path, scope };
  let bytes: Uint8Array;
  try {
    ({ bytes } = await library.read(principal, path));
  } catch (error) {
    if (isServiceError(error)) {
      const problem = error.code === "not_found" ? MISSING : error.message;
      return { ...base, problem };
    }
    throw error;
  }
  let text: string;
  try {
    text = strictUtf8.decode(bytes);
  } catch {
    return { ...base, problem: NOT_UTF8 };
  }
  const result = readSkillMeta(text, folder);
  if ("error" in result) {
    return { ...base, problem: result.error };
  }
  return {
    ...base,
    description: result.meta.description,
    name: result.meta.name,
    problem: null,
  };
};

/** Code unit order, so the same files always sort the same way. */
const byPath = (left: SkillFile, right: SkillFile): number => {
  if (left.path === right.path) {
    return 0;
  }
  return left.path < right.path ? -1 : 1;
};

export const createSkillsService = ({
  agents,
  library,
}: {
  agents: Pick<AgentsService, "get">;
  library: SkillsLibrary;
}) => {
  /** The skill names each root holds, mapped to the root that wins for that name. */
  const winningRoots = async (
    principal: RunPrincipal
  ): Promise<Map<string, string>> => {
    const own = `${SKILLS_DIR}/${principal.agentId}`;
    const shared = `${SKILLS_DIR}/${SHARED_DIR}`;
    const winners = new Map<string, string>();
    for (const entry of await listOrEmpty(library, principal, shared)) {
      if (entry.kind === "dir") {
        winners.set(lastSegment(entry.path), shared);
      }
    }
    for (const entry of await listOrEmpty(library, principal, own)) {
      if (entry.kind === "dir") {
        winners.set(lastSegment(entry.path), own);
      }
    }
    return winners;
  };

  const list = async (
    principal: Principal,
    runId: string
  ): Promise<SkillFile[]> => {
    const run = requireRun(principal, "skills.list", runId);
    const start = [...(await winningRoots(run))].map(([skill, root]) => ({
      dir: `${root}/${skill}`,
      path: skill,
    }));
    const files: SkillFile[] = [];
    let bytes = 0;
    await walkFiles(library, run, start, (file) => {
      files.push(file);
      bytes += file.size;
      if (files.length > SKILLS_MAX_FILES || bytes > SKILLS_MAX_BYTES) {
        throw invalid(TOO_BIG);
      }
    });
    return files.sort(byPath);
  };

  const read = async (
    principal: Principal,
    runId: string,
    path: string
  ): Promise<Uint8Array> => {
    const run = requireRun(principal, "skills.read", runId);
    const segments = relativeSegments(path);
    const relative = segments.join("/");
    const own = `${SKILLS_DIR}/${run.agentId}`;
    const ownSkill = `${own}/${segments[0]}`;
    const root = (await isFolder(library, run, ownSkill))
      ? own
      : `${SKILLS_DIR}/${SHARED_DIR}`;
    const { bytes } = await library.read(run, `${root}/${relative}`);
    return bytes;
  };

  /** The skills an agent sees on the Skills tab: its own first, then the shared ones, each by folder. */
  const catalog = async (
    principal: Principal,
    agentId: string
  ): Promise<SkillCatalogEntry[]> => {
    await agents.get(principal, agentId);
    const roots: { root: string; scope: SkillScope }[] = [
      { root: `${SKILLS_DIR}/${agentId}`, scope: "agent" },
      { root: `${SKILLS_DIR}/${SHARED_DIR}`, scope: "shared" },
    ];
    const groups = await Promise.all(
      roots.map(async ({ root, scope }) => {
        const folders = (await listOrEmpty(library, principal, root))
          .filter((entry) => entry.kind === "dir")
          .map((entry) => lastSegment(entry.path))
          .sort();
        return Promise.all(
          folders.map((folder) =>
            catalogEntry(library, principal, scope, root, folder)
          )
        );
      })
    );
    return groups.flat();
  };

  /** A new skill folder for the agent, with the template SKILL.md. Nothing is written when the name is refused. */
  const create = async (
    principal: Principal,
    agentId: string,
    name: string
  ): Promise<{ path: string }> => {
    await agents.get(principal, agentId);
    requireSkillName(name);
    const folder = `${SKILLS_DIR}/${agentId}/${name}`;
    if (await exists(library, principal, folder)) {
      throw new ServiceError("conflict", NAME_TAKEN);
    }
    const path = `${folder}/${SKILL_FILE}`;
    await library.write(
      principal,
      path,
      new TextEncoder().encode(TEMPLATE(name))
    );
    return { path };
  };

  /** The folder of one skill on the Skills tab. The agent must be visible, the name valid and the folder present. */
  const skillFolder = async (
    principal: Principal,
    agentId: string,
    scope: SkillScope,
    skill: string
  ): Promise<string> => {
    await agents.get(principal, agentId);
    requireSkillName(skill);
    const root =
      scope === "agent"
        ? `${SKILLS_DIR}/${agentId}/${skill}`
        : `${SKILLS_DIR}/${SHARED_DIR}/${skill}`;
    if (!(await isFolder(library, principal, root))) {
      throw notFound();
    }
    return root;
  };

  const treeAt = async (
    principal: Principal,
    folder: string
  ): Promise<SkillFile[]> => {
    const files: SkillFile[] = [];
    await walkFiles(library, principal, [{ dir: folder, path: "" }], (file) => {
      files.push(file);
    });
    return files.sort(byPath);
  };

  /** Every file under a skill folder, with its path relative to that folder. Folders are not listed. */
  const tree = async (
    principal: Principal,
    agentId: string,
    scope: SkillScope,
    skill: string
  ): Promise<SkillFile[]> =>
    treeAt(principal, await skillFolder(principal, agentId, scope, skill));

  const readFile = async (
    principal: Principal,
    agentId: string,
    scope: SkillScope,
    skill: string,
    path: string
  ): Promise<{ bytes: Uint8Array; entry: LibraryEntry }> => {
    const folder = await skillFolder(principal, agentId, scope, skill);
    return library.read(principal, `${folder}/${filePath(path)}`);
  };

  /** Writes one file of a skill. Nothing is written when the skill would pass the file or byte cap. */
  const writeFile = async (
    principal: Principal,
    agentId: string,
    scope: SkillScope,
    skill: string,
    path: string,
    bytes: Uint8Array,
    options: { ifEtag?: string } = {}
  ): Promise<LibraryEntry> => {
    const folder = await skillFolder(principal, agentId, scope, skill);
    const relative = filePath(path);
    const others = (await treeAt(principal, folder)).filter(
      (file) => file.path !== relative
    );
    const files = others.length + 1;
    const total =
      others.reduce((sum, file) => sum + file.size, 0) + bytes.byteLength;
    if (files > SKILLS_MAX_FILES || total > SKILLS_MAX_BYTES) {
      throw invalid(TOO_BIG);
    }
    return library.write(principal, `${folder}/${relative}`, bytes, options);
  };

  /** Removes one file of a skill. A folder is refused. */
  const removeFile = async (
    principal: Principal,
    agentId: string,
    scope: SkillScope,
    skill: string,
    path: string
  ): Promise<void> => {
    const folder = await skillFolder(principal, agentId, scope, skill);
    const target = `${folder}/${filePath(path)}`;
    const entry = await library.stat(principal, target);
    if (entry.kind !== "file") {
      throw invalid("Path is a folder");
    }
    await library.remove(principal, target);
  };

  return { catalog, create, list, read, readFile, removeFile, tree, writeFile };
};

export type SkillsService = ReturnType<typeof createSkillsService>;
