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
import { ForbiddenError } from "./authz.ts";
import { isServiceError, ServiceError } from "./errors.ts";
import type { LibraryService } from "./library.ts";
import type { Principal } from "./workspaces.ts";

type RunPrincipal = Extract<Principal, { kind: "run" }>;

export type SkillsLibrary = Pick<LibraryService, "list" | "read" | "stat">;

const SKILLS_DIR = "skills";
const SHARED_DIR = "_shared";
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
const relativeSegments = (path: string): string[] => {
  if (path.startsWith("/") || path.startsWith("\\")) {
    throw invalid("Skill path must be relative");
  }
  if (CONTROL_CHARS.test(path)) {
    throw invalid("Skill path contains control characters");
  }
  const segments = path.split("/");
  if (segments.length < 2) {
    throw invalid("Skill path needs a skill folder and a file");
  }
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw invalid("Skill path has an empty or dot segment");
    }
  }
  return segments;
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

/** Code unit order, so the same files always sort the same way. */
const byPath = (left: SkillFile, right: SkillFile): number => {
  if (left.path === right.path) {
    return 0;
  }
  return left.path < right.path ? -1 : 1;
};

export const createSkillsService = ({
  library,
}: {
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
    const pending = [...(await winningRoots(run))].map(([skill, root]) => ({
      dir: `${root}/${skill}`,
      path: skill,
    }));
    const files: SkillFile[] = [];
    let bytes = 0;
    for (let next = pending.pop(); next; next = pending.pop()) {
      // biome-ignore lint/performance/noAwaitInLoops: one folder at a time keeps the cap exact
      const entries = await library.list(run, next.dir);
      for (const entry of entries) {
        const path = `${next.path}/${lastSegment(entry.path)}`;
        if (entry.kind === "dir") {
          pending.push({ dir: entry.path, path });
        } else if (entry.etag !== null) {
          files.push({ etag: entry.etag, path, size: entry.size });
          bytes += entry.size;
          if (files.length > SKILLS_MAX_FILES || bytes > SKILLS_MAX_BYTES) {
            throw invalid(TOO_BIG);
          }
        }
      }
    }
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

  return { list, read };
};

export type SkillsService = ReturnType<typeof createSkillsService>;
