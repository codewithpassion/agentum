// Adapted from trueforge (packages/trueforge-ui, ImportGithubSkillForm.tsx), MIT licence, Copyright (c) 2024-2026 TrueFoundry.
import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useMemo,
  useState,
} from "react";
import {
  checkGithubImport,
  type GithubImportErrors,
  repoSlug,
  shortSha,
} from "#/components/skills/github-source-logic.ts";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Label } from "#/components/ui/label.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import { errorMessage } from "#/lib/error-message";

interface ImportFields {
  path: string;
  ref: string;
  url: string;
}

interface ImportResult {
  commitSha: string | null;
  repo: string;
  summary: string;
}

const EMPTY_FIELDS: ImportFields = { path: "", ref: "", url: "" };

export interface ImportGithubFormProps {
  onDone: () => void;
}

export function ImportGithubForm({ onDone }: ImportGithubFormProps) {
  const [fields, setFields] = useState<ImportFields>(EMPTY_FIELDS);
  const [touched, setTouched] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const check = useMemo(() => checkGithubImport(fields), [fields]);
  const errors: GithubImportErrors = touched && !check.ok ? check.errors : {};

  const changeUrl = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      setFields((prev) => ({ ...prev, url: event.target.value })),
    []
  );

  const changePath = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      setFields((prev) => ({ ...prev, path: event.target.value })),
    []
  );

  const changeRef = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      setFields((prev) => ({ ...prev, ref: event.target.value })),
    []
  );

  const submit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setTouched(true);
      if (!check.ok) {
        return;
      }
      const { value } = check;
      setImporting(true);
      setImportError(null);
      setResult(null);
      try {
        const imported = await getTrpc().skillStore.importGithub.mutate({
          ref: value.ref,
          url: value.url,
          ...(value.path === undefined ? {} : { path: value.path }),
        });
        const skills = await getTrpc().skillStore.list.query();
        const entry = skills.find(
          (skill) => skill.id === imported.version.skillId
        );
        setFields(EMPTY_FIELDS);
        setTouched(false);
        setResult({
          commitSha: entry?.source?.commitSha ?? null,
          repo: repoSlug(value.url),
          summary: imported.created
            ? `Created skill ${imported.name}`
            : `Added version ${imported.version.number} to ${imported.name}`,
        });
        onDone();
      } catch (cause) {
        setImportError(errorMessage(cause));
      } finally {
        setImporting(false);
      }
    },
    [check, onDone]
  );

  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <h2 className="font-heading text-foreground text-xl">
        Import from GitHub
      </h2>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="skill-github-url">Repository URL</Label>
        <Input
          aria-invalid={errors.url !== undefined}
          data-testid="skill-github-url"
          id="skill-github-url"
          onChange={changeUrl}
          placeholder="https://github.com/owner/repo"
          value={fields.url}
        />
        {errors.url === undefined ? null : (
          <p
            className="text-destructive text-sm"
            data-testid="skill-github-url-error"
          >
            {errors.url}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="skill-github-path">Folder path (optional)</Label>
        <Input
          aria-invalid={errors.path !== undefined}
          data-testid="skill-github-path"
          id="skill-github-path"
          onChange={changePath}
          value={fields.path}
        />
        {errors.path === undefined ? null : (
          <p
            className="text-destructive text-sm"
            data-testid="skill-github-path-error"
          >
            {errors.path}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="skill-github-ref">Ref (optional)</Label>
        <Input
          aria-invalid={errors.ref !== undefined}
          data-testid="skill-github-ref"
          id="skill-github-ref"
          onChange={changeRef}
          placeholder="Branch, tag or commit. Default branch if empty"
          value={fields.ref}
        />
        {errors.ref === undefined ? null : (
          <p
            className="text-destructive text-sm"
            data-testid="skill-github-ref-error"
          >
            {errors.ref}
          </p>
        )}
      </div>
      <Button
        data-testid="skill-github-submit"
        disabled={importing}
        type="submit"
      >
        Import
      </Button>
      {result === null ? null : (
        <p className="text-sm" data-testid="skill-github-result">
          {result.summary}
          {result.commitSha === null ? null : (
            <>
              {` from ${result.repo} at `}
              <code title={result.commitSha}>{shortSha(result.commitSha)}</code>
            </>
          )}
        </p>
      )}
      {importError === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {importError}
        </p>
      )}
    </form>
  );
}
