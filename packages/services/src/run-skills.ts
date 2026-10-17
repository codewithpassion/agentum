/**
 * The skills a run reads (SK.2), from the central skills store. Machines,
 * Cloudflare runs, the Linux VM and Managed Agents all get an agent's skills
 * through here. A file's path is `<skill name>/<path in the skill>`, the same
 * layout the library folders had. The store decides which version each skill
 * is at: the pinned one, else the latest approved one. A proposed version is
 * never part of this set. Only a run reads them, and only its own agent's.
 */
import { SKILLS_MAX_BYTES, SKILLS_MAX_FILES } from "@repo/protocol/skills";
import { ForbiddenError } from "./authz.ts";
import { ServiceError } from "./errors.ts";
import { assertSafePath } from "./skills-store/paths.ts";
import type { ResolvedSkill } from "./skills-store/records.ts";
import type { SkillsStoreService } from "./skills-store.ts";
import type { Principal } from "./workspaces.ts";

type RunPrincipal = Extract<Principal, { kind: "run" }>;

/** One file of the run's skills. `etag` is the content hash. */
export interface RunSkillFile {
  etag: string;
  executable: boolean;
  path: string;
  size: number;
}

export type RunSkillsStore = Pick<SkillsStoreService, "forAgent">;

const TOO_BIG = "Skills are limited to 200 files and 5 MB";

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
    throw new ServiceError("not_found", "Not found");
  }
  return principal;
};

/** Code unit order, so the same files always sort the same way. */
const byPath = (left: RunSkillFile, right: RunSkillFile): number => {
  if (left.path === right.path) {
    return 0;
  }
  return left.path < right.path ? -1 : 1;
};

/** Throws when the skills together pass the file or byte cap. */
const assertWithinCaps = (resolved: readonly ResolvedSkill[]): void => {
  let files = 0;
  let bytes = 0;
  for (const skill of resolved) {
    files += skill.files.length;
    for (const file of skill.files) {
      bytes += file.size;
    }
  }
  if (files > SKILLS_MAX_FILES || bytes > SKILLS_MAX_BYTES) {
    throw new ServiceError("invalid", TOO_BIG);
  }
};

export const createRunSkillsService = ({
  skillsStore,
}: {
  skillsStore: RunSkillsStore;
}) => {
  /** The run's agent's skills at the versions they resolve to, without file contents. Over the caps is `invalid`. */
  const resolve = async (
    principal: Principal,
    runId: string
  ): Promise<ResolvedSkill[]> => {
    const run = requireRun(principal, "skills.list", runId);
    const resolved = await skillsStore.forAgent(run, run.agentId);
    assertWithinCaps(resolved);
    return resolved;
  };

  const list = async (
    principal: Principal,
    runId: string
  ): Promise<RunSkillFile[]> => {
    const resolved = await resolve(principal, runId);
    return resolved
      .flatMap((skill) =>
        skill.files.map((file) => ({
          etag: file.hash,
          executable: file.executable,
          path: `${skill.name}/${file.path}`,
          size: file.size,
        }))
      )
      .sort(byPath);
  };

  const read = async (
    principal: Principal,
    runId: string,
    path: string
  ): Promise<Uint8Array> => {
    const run = requireRun(principal, "skills.read", runId);
    assertSafePath(path);
    const [skill] = await skillsStore.forAgent(run, run.agentId, {
      paths: [path],
      withContents: true,
    });
    const content = skill?.files[0]?.content;
    if (content === undefined) {
      throw new ServiceError("not_found", "Not found");
    }
    return content;
  };

  return { list, read, resolve };
};

export type RunSkillsService = ReturnType<typeof createRunSkillsService>;
