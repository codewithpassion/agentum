/**
 * Puts an agent's workspace skills on its Anthropic agent. Each skill is
 * mirrored to Anthropic's Skills API as one custom skill, and the Anthropic
 * agent lists the mirrors. The sandbox mounts a listed skill, with every file
 * of it, under `/workspace/skills/<name>/`.
 *
 * `managed_skills` remembers what each mirror was uploaded from. A skill whose
 * files changed gets a new version, a new skill gets a mirror, and a mirror
 * whose skill is gone is detached with the next agent sync and then deleted.
 */
import type { Database } from "@repo/db";
import { managedSkills } from "@repo/db/schema/managed";
import type { SkillFile } from "@repo/protocol/skills";
import { and, eq, inArray } from "drizzle-orm";
import { hashToken } from "../crypto.ts";
import { readSkillMeta } from "../library/skill-file.ts";
import type { ManagedGateway, SkillRef } from "./gateway.ts";

/** Anthropic takes at most this many skills on one agent. */
export const MAX_SKILLS = 20;

const SKILL_FILE = "SKILL.md";
const decoder = new TextDecoder();

/** The agent's skills as the workspace library has them, read through the skills service. */
export interface SkillsSource {
  list: () => Promise<readonly SkillFile[]>;
  read: (path: string) => Promise<Uint8Array>;
}

/** A valid skill folder: its name, its files (library paths) and a hash of their etags. */
export interface LocalSkill {
  files: readonly SkillFile[];
  hash: string;
  name: string;
}

const splitPath = (path: string): { folder: string; relative: string } => {
  const slash = path.indexOf("/");
  return { folder: path.slice(0, slash), relative: path.slice(slash + 1) };
};

const hashOf = (files: readonly SkillFile[]): Promise<string> =>
  hashToken(JSON.stringify(files.map((file) => [file.path, file.etag])));

const byName = (left: LocalSkill, right: LocalSkill): number => {
  if (left.name === right.name) {
    return 0;
  }
  return left.name < right.name ? -1 : 1;
};

/**
 * The skills the agent has: every folder with a SKILL.md whose frontmatter
 * name matches the folder. A folder without a valid one is left out, as it is
 * for the other runtimes.
 */
export const loadLocalSkills = async (
  source: SkillsSource
): Promise<LocalSkill[]> => {
  const folders = new Map<string, SkillFile[]>();
  for (const file of await source.list()) {
    const { folder } = splitPath(file.path);
    folders.set(folder, [...(folders.get(folder) ?? []), file]);
  }
  const loaded = await Promise.all(
    [...folders].map(async ([name, files]): Promise<LocalSkill | undefined> => {
      if (!files.some((file) => file.path === `${name}/${SKILL_FILE}`)) {
        return;
      }
      const text = decoder.decode(await source.read(`${name}/${SKILL_FILE}`));
      if ("error" in readSkillMeta(text, name)) {
        return;
      }
      return { files, hash: await hashOf(files), name };
    })
  );
  return loaded
    .filter((skill): skill is LocalSkill => skill !== undefined)
    .sort(byName);
};

/** The files of a skill, read from the library, with paths relative to the skill folder. */
const uploadOf = async (skill: LocalSkill, source: SkillsSource) => ({
  files: await Promise.all(
    skill.files.map(async (file) => ({
      content: await source.read(file.path),
      path: splitPath(file.path).relative,
    }))
  ),
  name: skill.name,
});

type SkillRow = typeof managedSkills.$inferSelect;

export interface SyncedSkills {
  /** What the Anthropic agent lists, in skill name order. */
  refs: SkillRef[];
  /** Mirrors of skills the agent no longer has. Pass them to `removeStale` once the agent stopped listing them. */
  stale: SkillRow[];
}

export const createSkillsSync = ({
  db,
  now,
}: {
  db: Database;
  now: () => string;
}) => {
  const rowsOf = (agentId: string) =>
    db.select().from(managedSkills).where(eq(managedSkills.agentId, agentId));

  const displayTitle = (agentId: string, name: string) =>
    `harbourmaster ${agentId} ${name}`;

  /** A mirror for a skill that has none. Two launches racing keep the row that won and delete the other upload. */
  const mirror = async ({
    agent,
    gateway,
    skill,
    source,
  }: {
    agent: { id: string; workspaceId: string };
    gateway: ManagedGateway;
    skill: LocalSkill;
    source: SkillsSource;
  }): Promise<SkillRow> => {
    const upload = await uploadOf(skill, source);
    const created = await gateway.createSkill({
      ...upload,
      displayTitle: displayTitle(agent.id, skill.name),
    });
    const row: SkillRow = {
      agentId: agent.id,
      anthropicSkillId: created.skillId,
      anthropicVersion: created.version,
      contentHash: skill.hash,
      createdAt: now(),
      name: skill.name,
      syncedAt: now(),
      workspaceId: agent.workspaceId,
    };
    await db.insert(managedSkills).values(row).onConflictDoNothing();
    const [winner] = await db
      .select()
      .from(managedSkills)
      .where(
        and(
          eq(managedSkills.agentId, agent.id),
          eq(managedSkills.name, skill.name)
        )
      )
      .limit(1);
    if (winner && winner.anthropicSkillId !== created.skillId) {
      await gateway.deleteSkill(created.skillId);
      return winner;
    }
    return row;
  };

  /** A new version of a mirror whose skill changed. */
  const update = async ({
    gateway,
    row,
    skill,
    source,
  }: {
    gateway: ManagedGateway;
    row: SkillRow;
    skill: LocalSkill;
    source: SkillsSource;
  }): Promise<SkillRow> => {
    const version = await gateway.createSkillVersion({
      ...(await uploadOf(skill, source)),
      skillId: row.anthropicSkillId,
    });
    const next = {
      anthropicVersion: version,
      contentHash: skill.hash,
      syncedAt: now(),
    };
    await db
      .update(managedSkills)
      .set(next)
      .where(
        and(
          eq(managedSkills.agentId, row.agentId),
          eq(managedSkills.name, row.name)
        )
      );
    return { ...row, ...next };
  };

  /** Brings the mirrors up to date with the skills and says what the Anthropic agent should list. */
  const sync = async ({
    agent,
    gateway,
    local,
    source,
  }: {
    agent: { id: string; workspaceId: string };
    gateway: ManagedGateway;
    local: readonly LocalSkill[];
    source: SkillsSource;
  }): Promise<SyncedSkills> => {
    const rows = new Map(
      (await rowsOf(agent.id)).map((row) => [row.name, row])
    );
    const refs: SkillRef[] = [];
    // One skill at a time: each upload is a large request, and a failure should stop the rest.
    for (const skill of local) {
      const row = rows.get(skill.name);
      let current: SkillRow;
      if (!row) {
        // biome-ignore lint/performance/noAwaitInLoops: uploads run one at a time
        current = await mirror({ agent, gateway, skill, source });
      } else if (row.contentHash === skill.hash) {
        current = row;
      } else {
        // biome-ignore lint/performance/noAwaitInLoops: uploads run one at a time
        current = await update({ gateway, row, skill, source });
      }
      refs.push({
        skillId: current.anthropicSkillId,
        version: current.anthropicVersion,
      });
    }
    const names = new Set(local.map((skill) => skill.name));
    const stale = [...rows.values()].filter((row) => !names.has(row.name));
    return { refs, stale };
  };

  /** Deletes mirrors the agent no longer lists. Best effort: a failure leaves an unused skill at Anthropic and the row for the next try. */
  const removeStale = async (
    gateway: ManagedGateway,
    stale: readonly SkillRow[]
  ): Promise<void> => {
    const removed: string[] = [];
    for (const row of stale) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: one delete at a time
        await gateway.deleteSkill(row.anthropicSkillId);
        removed.push(row.name);
      } catch (error) {
        console.error(
          `Deleting the mirror of skill ${row.name} failed:`,
          error instanceof Error ? error.name : "unknown error"
        );
      }
    }
    const [first] = stale;
    if (first && removed.length > 0) {
      await db
        .delete(managedSkills)
        .where(
          and(
            eq(managedSkills.agentId, first.agentId),
            inArray(managedSkills.name, removed)
          )
        );
    }
  };

  return { removeStale, sync };
};

export type SkillsSync = ReturnType<typeof createSkillsSync>;

/** What the agent is told about its skills. Empty when it has none. */
export const skillsGuidance = (names: readonly string[]): string =>
  names.length === 0
    ? ""
    : `# Skills

You have these skills: ${names.join(", ")}. Each is a folder under /workspace/skills/<name>/ with a SKILL.md. Read a skill's SKILL.md before you use it, and follow it.

A skill may ship scripts. Run a TypeScript script directly with bun, for example \`bun /workspace/skills/<name>/scripts/<script>.ts <args>\`. Bun is installed in your sandbox and needs no build step or install for a script that imports only its own files and built-in APIs. Scripts can reach the internet.`;
