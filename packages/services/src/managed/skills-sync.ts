/**
 * Puts an agent's skills on its Anthropic agent. Each version of a central
 * skill (SK.2) is uploaded once to Anthropic's Skills API, and the Anthropic
 * agent lists the uploaded versions. A pin therefore maps to that version and
 * an unpinned skill to the latest approved one, because the central store has
 * already resolved each skill to one version. The sandbox mounts a listed
 * skill, with every file of it, under `/workspace/skills/<name>/`.
 *
 * `managed_skill_versions` remembers the upload of each Harbourmaster skill id
 * and version number, shared by every agent that carries it. All versions of
 * one skill are versions of one Anthropic skill.
 *
 * `managed_skills` holds the per-agent mirrors of the library era. Nothing
 * writes it now. They are reported as stale, so the next launch of each agent
 * deletes them at Anthropic.
 */
import type { Database } from "@repo/db";
import { managedSkills, managedSkillVersions } from "@repo/db/schema/managed";
import { and, eq, inArray } from "drizzle-orm";
import type { ResolvedSkill } from "../skills-store/records.ts";
import type { ManagedGateway, SkillRef, SkillUploadFile } from "./gateway.ts";

/** Anthropic takes at most this many skills on one agent. */
export const MAX_SKILLS = 20;

/** The agent's skills as the central store resolves them for a run. */
export interface SkillsSource {
  /** The files of one version, with their contents. Called only for a version that has no upload yet. */
  files: (
    skillId: string,
    version: number
  ) => Promise<readonly SkillUploadFile[]>;
  /** The skills the agent carries, each at its pinned version or the latest approved one, by name. */
  list: () => Promise<readonly ResolvedSkill[]>;
}

/** What a sync asks of the Anthropic side. */
type SkillsGateway = Pick<
  ManagedGateway,
  "createSkill" | "createSkillVersion" | "deleteSkill"
>;

type SkillRow = typeof managedSkills.$inferSelect;
type VersionRow = typeof managedSkillVersions.$inferSelect;

export interface SyncedSkills {
  /** What the Anthropic agent lists, in skill name order. */
  refs: SkillRef[];
  /** The agent's per-agent mirrors from before SK.2. Pass them to `removeStale` once the agent stopped listing them. */
  stale: SkillRow[];
}

const refOf = (row: VersionRow): SkillRef => ({
  skillId: row.anthropicSkillId,
  version: row.anthropicVersion,
});

export const createSkillsSync = ({
  db,
  now,
}: {
  db: Database;
  now: () => string;
}) => {
  const rowsOf = (agentId: string) =>
    db.select().from(managedSkills).where(eq(managedSkills.agentId, agentId));

  const versionRow = async (
    skillId: string,
    version: number
  ): Promise<VersionRow | undefined> => {
    const [row] = await db
      .select()
      .from(managedSkillVersions)
      .where(
        and(
          eq(managedSkillVersions.skillId, skillId),
          eq(managedSkillVersions.version, version)
        )
      )
      .limit(1);
    return row;
  };

  const displayTitle = (skillId: string, name: string) =>
    `harbourmaster ${skillId} ${name}`;

  /** A new Anthropic skill, holding the first uploaded version of a skill. */
  const createdSkill = async (
    gateway: SkillsGateway,
    skill: ResolvedSkill,
    files: readonly SkillUploadFile[]
  ) => {
    const created = await gateway.createSkill({
      displayTitle: displayTitle(skill.skillId, skill.name),
      files,
      name: skill.name,
    });
    return {
      anthropicSkillId: created.skillId,
      anthropicVersion: created.version,
    };
  };

  /**
   * The upload of one version of a skill, made when it has none. Another
   * version of the skill, when uploaded, names the Anthropic skill to add a
   * version to. Two launches racing keep the row that won; the loser's upload
   * of a new Anthropic skill is deleted, a lost extra version is left unused.
   */
  const upload = async ({
    gateway,
    skill,
    source,
    workspaceId,
  }: {
    gateway: SkillsGateway;
    skill: ResolvedSkill;
    source: SkillsSource;
    workspaceId: string;
  }): Promise<VersionRow> => {
    const files = await source.files(skill.skillId, skill.version);
    const [sibling] = await db
      .select()
      .from(managedSkillVersions)
      .where(eq(managedSkillVersions.skillId, skill.skillId))
      .limit(1);
    const { anthropicSkillId, anthropicVersion } = sibling
      ? {
          anthropicSkillId: sibling.anthropicSkillId,
          anthropicVersion: await gateway.createSkillVersion({
            files,
            name: skill.name,
            skillId: sibling.anthropicSkillId,
          }),
        }
      : await createdSkill(gateway, skill, files);
    const row: VersionRow = {
      anthropicSkillId,
      anthropicVersion,
      createdAt: now(),
      skillId: skill.skillId,
      version: skill.version,
      workspaceId,
    };
    await db.insert(managedSkillVersions).values(row).onConflictDoNothing();
    const winner = await versionRow(skill.skillId, skill.version);
    if (
      winner &&
      (winner.anthropicSkillId !== anthropicSkillId ||
        winner.anthropicVersion !== anthropicVersion)
    ) {
      if (!sibling && winner.anthropicSkillId !== anthropicSkillId) {
        await gateway.deleteSkill(anthropicSkillId);
      }
      return winner;
    }
    return row;
  };

  /** Uploads the versions that have no upload yet and says what the Anthropic agent should list. */
  const sync = async ({
    agent,
    gateway,
    skills,
    source,
  }: {
    agent: { id: string; workspaceId: string };
    gateway: SkillsGateway;
    skills: readonly ResolvedSkill[];
    source: SkillsSource;
  }): Promise<SyncedSkills> => {
    const refs: SkillRef[] = [];
    // One version at a time: each upload is a large request, and a failure should stop the rest.
    for (const skill of skills) {
      // biome-ignore lint/performance/noAwaitInLoops: uploads run one at a time
      const known = await versionRow(skill.skillId, skill.version);
      refs.push(
        refOf(
          known ??
            (await upload({
              gateway,
              skill,
              source,
              workspaceId: agent.workspaceId,
            }))
        )
      );
    }
    return { refs, stale: await rowsOf(agent.id) };
  };

  /** Deletes mirrors the agent no longer lists. Best effort: a failure leaves an unused skill at Anthropic and the row for the next try. */
  const removeStale = async (
    gateway: SkillsGateway,
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
