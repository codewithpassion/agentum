import { useCallback, useState } from "react";
import { Button } from "#/components/ui/button";
import { TextAreaField, TextField } from "#/components/ui/field";
import type { SkillFileInput } from "#/lib/api";
import { SKILL_MD_PATH } from "#/modules/skills/validate";

/**
 * The file set of a version, edited as text. Skills are SKILL.md plus scripts -
 * text an author (or an agent) writes - so there is no upload here and the
 * server takes exactly this shape.
 *
 * SKILL.md cannot be renamed or removed: it is what makes the directory entry,
 * and the server refuses a version without it.
 */

function FileRow({
  file,
  onChangeContent,
  onRemove,
}: {
  file: SkillFileInput;
  onChangeContent: (path: string, content: string) => void;
  onRemove: (path: string) => void;
}) {
  const change = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) =>
      onChangeContent(file.path, event.target.value),
    [file.path, onChangeContent]
  );
  const remove = useCallback(() => onRemove(file.path), [file.path, onRemove]);
  const required = file.path === SKILL_MD_PATH;

  return (
    <li className="rounded-lg border border-[var(--ws-line)] p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="truncate font-mono text-[13px]">{file.path}</span>
        {required ? null : (
          <Button onClick={remove} size="sm" variant="danger">
            Remove
          </Button>
        )}
      </div>
      <TextAreaField
        label={`${file.path} content`}
        onChange={change}
        rows={required ? 14 : 8}
        spellCheck={false}
        value={file.content}
      />
    </li>
  );
}

export function SkillFilesEditor({
  files,
  onChange,
}: {
  files: SkillFileInput[];
  onChange: (files: SkillFileInput[]) => void;
}) {
  const [newPath, setNewPath] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const changeContent = useCallback(
    (path: string, content: string) =>
      onChange(
        files.map((file) => (file.path === path ? { content, path } : file))
      ),
    [files, onChange]
  );

  const removeFile = useCallback(
    (path: string) => onChange(files.filter((file) => file.path !== path)),
    [files, onChange]
  );

  const onNewPathChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      setNewPath(event.target.value),
    []
  );

  const addFile = useCallback(() => {
    const path = newPath.trim();
    if (path.length === 0) {
      return;
    }
    if (files.some((file) => file.path === path)) {
      setProblem(`"${path}" is already in this skill.`);
      return;
    }
    setProblem(null);
    setNewPath("");
    onChange([...files, { content: "", path }]);
  }, [files, newPath, onChange]);

  return (
    <div className="space-y-3">
      <ul
        className="m-0 list-none space-y-3 p-0"
        data-testid="skill-file-forms"
      >
        {files.map((file) => (
          <FileRow
            file={file}
            key={file.path}
            onChangeContent={changeContent}
            onRemove={removeFile}
          />
        ))}
      </ul>

      <div className="flex items-end gap-2">
        <div className="flex-1">
          <TextField
            hint="Relative to the skill root, e.g. scripts/run.sh. Text files only."
            label="Add a file"
            onChange={onNewPathChange}
            placeholder="scripts/run.sh"
            value={newPath}
          />
        </div>
        <Button onClick={addFile}>Add file</Button>
      </div>

      {problem ? (
        <p className="m-0 text-[var(--ws-danger)] text-xs">{problem}</p>
      ) : null}
    </div>
  );
}
