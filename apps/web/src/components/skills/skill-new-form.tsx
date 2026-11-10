import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useRef,
  useState,
} from "react";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Label } from "#/components/ui/label.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import { errorMessage } from "#/lib/error-message";
import { bytesToBase64 } from "#/lib/library-content.ts";

/** The SKILL.md a new skill starts with. Its frontmatter name must equal the skill name. */
export const buildSkillMarkdown = (name: string, description: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

export interface SkillNewFormProps {
  onDone: () => void;
}

export function SkillNewForm({ onDone }: SkillNewFormProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const fileInput = useRef<HTMLInputElement>(null);
  const [uploadResult, setUploadResult] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const changeName = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setName(event.target.value),
    []
  );

  const changeDescription = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      setDescription(event.target.value),
    []
  );

  const create = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const skillName = name.trim();
      setCreating(true);
      setCreateError(null);
      try {
        await getTrpc().skillStore.create.mutate({
          files: [
            {
              data: buildSkillMarkdown(skillName, description.trim()),
              encoding: "text",
              path: "SKILL.md",
            },
          ],
          message: `Create ${skillName}`,
          name: skillName,
        });
        setName("");
        setDescription("");
        onDone();
      } catch (cause) {
        setCreateError(errorMessage(cause));
      } finally {
        setCreating(false);
      }
    },
    [name, description, onDone]
  );

  const openFilePicker = useCallback(() => fileInput.current?.click(), []);

  const upload = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const input = event.currentTarget;
      const file = input.files?.[0];
      if (file === undefined) {
        return;
      }
      setUploadError(null);
      setUploadResult(null);
      try {
        const data = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
        const result = await getTrpc().skillStore.importArchive.mutate({
          data,
        });
        setUploadResult(
          result.created
            ? `Created skill ${result.name}`
            : `Added version ${result.version.number} to ${result.name}`
        );
        onDone();
      } catch (cause) {
        setUploadError(errorMessage(cause));
      } finally {
        input.value = "";
      }
    },
    [onDone]
  );

  return (
    <div className="grid gap-8 md:grid-cols-2">
      <form className="flex flex-col gap-3" onSubmit={create}>
        <h2 className="font-heading text-foreground text-xl">New skill</h2>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="skill-create-name">Name</Label>
          <Input
            data-testid="skill-create-name"
            id="skill-create-name"
            onChange={changeName}
            required
            value={name}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="skill-create-description">Description</Label>
          <Input
            data-testid="skill-create-description"
            id="skill-create-description"
            onChange={changeDescription}
            value={description}
          />
        </div>
        <Button
          data-testid="skill-create-submit"
          disabled={creating}
          type="submit"
        >
          Create skill
        </Button>
        {createError === null ? null : (
          <p className="text-destructive text-sm" role="alert">
            {createError}
          </p>
        )}
      </form>
      <div className="flex flex-col gap-3">
        <h2 className="font-heading text-foreground text-xl">Upload a skill</h2>
        <p className="text-muted-foreground text-sm">
          Add a .skill or .zip file. A known name adds a new version.
        </p>
        <div>
          <Button onClick={openFilePicker} type="button" variant="outline">
            Choose a .skill file
          </Button>
          <input
            accept=".skill,.zip"
            className="hidden"
            data-testid="skill-upload-input"
            onChange={upload}
            ref={fileInput}
            type="file"
          />
        </div>
        {uploadResult === null ? null : (
          <p className="text-sm" data-testid="skill-upload-result">
            {uploadResult}
          </p>
        )}
        {uploadError === null ? null : (
          <p className="text-destructive text-sm" role="alert">
            {uploadError}
          </p>
        )}
      </div>
    </div>
  );
}
