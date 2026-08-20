import Anthropic from "@anthropic-ai/sdk";
import { isAnthropicEnabled } from "./service";

/**
 * The Skills half of the Managed Agents surface, behind one interface for the
 * same reason as `gateway.ts` and `vaults.ts`: nothing outside this module
 * imports the SDK, so `modules/skills` never sees a beta API change.
 *
 * Every payload shape here is copied from the Phase 5 entry spike
 * (`scripts/anthropic-spike.ts skills`), which ran against the live API.
 */

export interface SkillUploadFile {
  content: string;
  contentType: string;
  /** Relative to the skill root; the slug directory is added here. */
  path: string;
}

export interface SkillUpload {
  displayTitle: string;
  files: readonly SkillUploadFile[];
  /** The top-level directory, which the API demands equals the frontmatter name. */
  slug: string;
}

export interface PublishedSkill {
  anthropicSkillId: string;
  anthropicVersion: string;
}

export interface SkillsGateway {
  createSkill: (upload: SkillUpload) => Promise<PublishedSkill>;
  /** A new version of an already-mirrored skill; same body as `createSkill`. */
  createVersion: (
    anthropicSkillId: string,
    upload: SkillUpload
  ) => Promise<string>;
  /**
   * Only ever called for a skill this workspace created. The API refuses while
   * any version exists, so every version goes first.
   */
  deleteSkill: (anthropicSkillId: string) => Promise<void>;
  deleteVersion: (
    anthropicSkillId: string,
    anthropicVersion: string
  ) => Promise<void>;
  listVersions: (anthropicSkillId: string) => Promise<string[]>;
}

/**
 * The upload's whole directory layout travels in the filenames: the skills
 * endpoint is the one place the SDK does *not* strip the path from a `File`
 * name (verified by the spike).
 */
const filesFor = (upload: SkillUpload): File[] =>
  upload.files.map(
    (file) =>
      new File([file.content], `${upload.slug}/${file.path}`, {
        type: file.contentType,
      })
  );

export const createSkillsGatewayFor = (client: Anthropic): SkillsGateway => ({
  async createSkill(upload) {
    const skill = await client.beta.skills.create({
      display_title: upload.displayTitle,
      files: filesFor(upload),
    });
    return {
      anthropicSkillId: skill.id,
      // The create response carries the version it just made; there is no
      // separate call, and no name/description at the skill level at all.
      anthropicVersion: skill.latest_version ?? "",
    };
  },

  async createVersion(anthropicSkillId, upload) {
    // No `display_title` here: it lives on the skill, and a version only
    // carries files (the name and description ride in SKILL.md's frontmatter).
    const version = await client.beta.skills.versions.create(anthropicSkillId, {
      files: filesFor(upload),
    });
    return version.version;
  },

  async deleteSkill(anthropicSkillId) {
    await client.beta.skills.delete(anthropicSkillId);
  },

  async deleteVersion(anthropicSkillId, anthropicVersion) {
    await client.beta.skills.versions.delete(anthropicVersion, {
      skill_id: anthropicSkillId,
    });
  },

  async listVersions(anthropicSkillId) {
    const page = await client.beta.skills.versions.list(anthropicSkillId);
    return page.data.map((version) => version.version);
  },
});

/**
 * Null when the Anthropic integration is off - the same contract as
 * `createGateway`. A skill created with no key is a perfectly good local skill:
 * it stays `unsynced` and reaches agents once a key exists and the retry runs.
 */
export const createSkills = (env: Env): SkillsGateway | null => {
  if (!isAnthropicEnabled(env)) {
    return null;
  }
  return createSkillsGatewayFor(
    new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
  );
};
