// What the Worker and the daemon agree on for an agent's skills (S.1). The
// daemon asks `GET /api/runs/:id/skills` for the file list, then fetches each
// file with `GET /api/runs/:id/skills/file?path=`. A path is relative to
// `.claude/skills/` and starts with the skill's folder: `shout/SKILL.md`.

import { z } from "zod";

/** Most files one agent's skills may hold. */
export const SKILLS_MAX_FILES = 200;

/** Most bytes, over all files, one agent's skills may hold: 5 MB. */
export const SKILLS_MAX_BYTES = 5 * 1024 * 1024;

export const skillFileSchema = z.strictObject({
  etag: z.string(),
  path: z.string().min(1),
  size: z.int().nonnegative(),
});
export type SkillFile = z.infer<typeof skillFileSchema>;

export const skillsListResponseSchema = z.strictObject({
  files: z.array(skillFileSchema),
});
export type SkillsListResponse = z.infer<typeof skillsListResponseSchema>;
