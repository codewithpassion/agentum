// Pure rules for the publish form: the skill id slug, the tags text and what must be fixed before publishing.
// No React, no calls.

export const DESCRIPTION_MAX = 2000;
export const SKILLS_MIN = 1;
export const SKILLS_MAX = 20;

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** One skill row as the owner types it. `idEdited` stops the id from following the name. */
export interface SkillDraft {
  description: string;
  id: string;
  idEdited: boolean;
  key: string;
  name: string;
  tags: string;
}

/** A skill as the publish service takes it. */
export interface PublishSkill {
  description: string;
  id: string;
  name: string;
  tags: string[];
}

export const emptySkill = (key: string): SkillDraft => ({
  description: "",
  id: "",
  idEdited: false,
  key,
  name: "",
  tags: "",
});

/** A lowercase slug of a name: words joined by dashes. Empty when the name has no letters or digits. */
export const slugOf = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** Sets the name. The id follows it until the owner edits the id by hand. */
export const withName = (skill: SkillDraft, name: string): SkillDraft => ({
  ...skill,
  id: skill.idEdited ? skill.id : slugOf(name),
  name,
});

export const withId = (skill: SkillDraft, id: string): SkillDraft => ({
  ...skill,
  id,
  idEdited: true,
});

/** The tags typed as comma separated text, trimmed, with no empty tags. */
export const parseTags = (text: string): string[] =>
  text
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);

/** The first thing wrong with one skill, in plain words, or null when it is complete. */
export const skillProblem = (skill: SkillDraft): string | null => {
  if (!SLUG.test(skill.id.trim())) {
    return "Each skill needs an id of lowercase letters, numbers and dashes.";
  }
  if (skill.name.trim() === "") {
    return "Each skill needs a name.";
  }
  if (skill.description.trim() === "") {
    return "Each skill needs a description.";
  }
  if (parseTags(skill.tags).length === 0) {
    return "Each skill needs at least one tag.";
  }
  return null;
};

/** The first thing to fix before the card can publish, or null when the form is ready. */
export const publishProblem = (
  description: string,
  skills: readonly SkillDraft[]
): string | null => {
  const text = description.trim();
  if (text === "") {
    return "Write a description for the public card.";
  }
  if (text.length > DESCRIPTION_MAX) {
    return `The description can be at most ${DESCRIPTION_MAX} characters.`;
  }
  if (skills.length < SKILLS_MIN || skills.length > SKILLS_MAX) {
    return `Keep between ${SKILLS_MIN} and ${SKILLS_MAX} skills.`;
  }
  for (const skill of skills) {
    const problem = skillProblem(skill);
    if (problem !== null) {
      return problem;
    }
  }
  return null;
};

/** The skills in the shape the publish service takes. Call only after `publishProblem` returns null. */
export const toPublishSkills = (
  skills: readonly SkillDraft[]
): PublishSkill[] =>
  skills.map((skill) => ({
    description: skill.description.trim(),
    id: skill.id.trim(),
    name: skill.name.trim(),
    tags: parseTags(skill.tags),
  }));
