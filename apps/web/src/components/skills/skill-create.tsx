import { useCallback, useState } from "react";
import { Button } from "#/components/ui/button";
import { TextField } from "#/components/ui/field";
import { createSkill, type Skill, type SkillFileInput } from "#/lib/api";
import { SKILL_MD_PATH } from "#/modules/skills/validate";
import { SkillFilesEditor } from "./skill-files-editor";
import { skillTemplate, withFrontmatterField } from "./skill-template";

/**
 * A new skill, written rather than uploaded (plan 5e, "Create skill"): the form
 * starts from a SKILL.md template and the slug field keeps the frontmatter
 * `name` in step with it, because the API refuses a version where they differ.
 *
 * Nothing is validated here that the server validates: its refusal is the
 * message, so the two can never disagree about what a skill must be.
 */

const START_DESCRIPTION = "Say when an agent should use this skill.";

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "Failed to create the skill.";

export function SkillCreateForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (skill: Skill) => Promise<void>;
}) {
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState(START_DESCRIPTION);
  const [files, setFiles] = useState<SkillFileInput[]>([
    { content: skillTemplate("", START_DESCRIPTION), path: SKILL_MD_PATH },
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Keeps SKILL.md's frontmatter in step with the two identity fields. */
  const syncFrontmatter = useCallback((key: string, value: string) => {
    setFiles((previous) =>
      previous.map((file) =>
        file.path === SKILL_MD_PATH
          ? {
              content: withFrontmatterField(file.content, key, value),
              path: file.path,
            }
          : file
      )
    );
  }, []);

  const onSlugChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setSlug(event.target.value);
      syncFrontmatter("name", event.target.value);
    },
    [syncFrontmatter]
  );

  const onDescriptionChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setDescription(event.target.value);
      syncFrontmatter("description", event.target.value);
    },
    [syncFrontmatter]
  );

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setBusy(true);
      setError(null);
      try {
        const created = await createSkill({ files, slug: slug.trim() });
        await onCreated(created.skill);
      } catch (cause) {
        setError(messageOf(cause));
      } finally {
        setBusy(false);
      }
    },
    [files, onCreated, slug]
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6">
      <form className="mx-auto max-w-2xl space-y-5" onSubmit={submit}>
        <header className="space-y-1">
          <h2 className="m-0 font-semibold text-lg">New skill</h2>
          <p className="m-0 text-[var(--ws-muted)] text-xs">
            A skill is a SKILL.md and whatever files it needs. Agents you assign
            it to read it in their sessions.
          </p>
        </header>

        <TextField
          hint="Lowercase letters, digits and hyphens. This is the address, the directory name and SKILL.md's name field."
          label="Slug"
          maxLength={64}
          onChange={onSlugChange}
          placeholder="weekly-report"
          required
          value={slug}
        />
        <TextField
          hint="Shown in the directory, and what tells an agent when to reach for this skill."
          label="Description"
          maxLength={2000}
          onChange={onDescriptionChange}
          value={description}
        />

        <SkillFilesEditor files={files} onChange={setFiles} />

        {error ? (
          <p className="m-0 text-[var(--ws-danger)] text-xs" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button onClick={onCancel} variant="ghost">
            Cancel
          </Button>
          <Button disabled={busy} type="submit" variant="primary">
            Create skill
          </Button>
        </div>
      </form>
    </div>
  );
}
