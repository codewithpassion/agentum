import type { AgentTemplateId } from "@repo/db/shared";
import { Link } from "@tanstack/react-router";
import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useId,
  useState,
} from "react";
import {
  DESCRIPTION_LIMIT,
  loadDescription,
  saveDescription,
} from "#/components/agent/builder/builder-logic.ts";
import { TemplateGallery } from "#/components/agent/builder/template-gallery.tsx";
import {
  ProviderKeyForm,
  type ProviderKeyStatus,
} from "#/components/model-providers/provider-key-form.tsx";
import { Button } from "#/components/ui/button";
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";

const STEP_NUMBER_CLASS =
  "flex size-6 shrink-0 items-center justify-center rounded-full border border-border text-xs";
const CHECK_MARK = "✓";
const KEY_NOTE =
  "Stored encrypted. It is never shown again, only its last four characters are.";
const KEY_EXPLANATION =
  "Your agents think on your own Anthropic account, so Anthropic bills you directly for what they use. Paste an API key and you're set.";
const NEEDS_KEY_HINT =
  "Add your AI account above to draft from a description. Templates work without one.";

const noRemove = (): Promise<unknown> => Promise.resolve();

const StepTitle = ({ number, title }: { number: number; title: string }) => (
  <div className="flex items-center gap-3">
    <span aria-hidden="true" className={STEP_NUMBER_CLASS}>
      {number}
    </span>
    <h2 className="font-heading text-foreground text-xl">{title}</h2>
  </div>
);

const KeyDone = () => (
  <div className="flex flex-col gap-1 text-sm">
    <p className="text-foreground">
      <span aria-hidden="true">{CHECK_MARK} </span>
      <strong className="font-medium">Done</strong>
      <span className="text-muted-foreground"> Your AI account is added.</span>
    </p>
    <Link
      className="w-fit underline underline-offset-4"
      to="/settings/model-providers"
    >
      Manage keys
    </Link>
  </div>
);

/** The two-step Home guide for a workspace with no agents: the AI account, then a template or a description. */
export const FirstRunGuide = ({
  anthropic,
  hasKey,
  onContinue,
  onPickTemplate,
  onSaveKey,
}: {
  anthropic: ProviderKeyStatus;
  hasKey: boolean;
  onContinue: () => void;
  onPickTemplate: (id: AgentTemplateId) => void;
  onSaveKey: (apiKey: string) => Promise<unknown>;
}) => {
  const descriptionId = useId();
  const hintId = useId();
  const [description, setDescription] = useState("");

  useEffect(() => {
    setDescription(loadDescription(window.sessionStorage));
  }, []);

  const handleDescription = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const text = event.currentTarget.value;
      setDescription(text);
      saveDescription(window.sessionStorage, text);
    },
    []
  );

  const canContinue = hasKey && description.trim() !== "";

  return (
    <section
      aria-label="First run"
      className="flex flex-col gap-8"
      data-testid="first-run-guide"
    >
      <ol className="flex flex-col gap-8">
        <li className="flex flex-col gap-3">
          <StepTitle number={1} title="Add your AI account" />
          {hasKey ? (
            <KeyDone />
          ) : (
            <>
              <p className="text-muted-foreground text-sm">{KEY_EXPLANATION}</p>
              <ProviderKeyForm
                description={KEY_NOTE}
                inputId="first-run-api-key"
                onRemove={noRemove}
                onSave={onSaveKey}
                placeholder="sk-ant-..."
                status={anthropic}
                title="Anthropic API key"
              />
            </>
          )}
        </li>
        <li className="flex flex-col gap-3">
          <StepTitle number={2} title="Pick a template or describe an agent" />
          <TemplateGallery busy={false} onPick={onPickTemplate} />
          <div className="flex flex-col gap-2">
            <Label
              className="text-muted-foreground text-xs uppercase tracking-wide"
              htmlFor={descriptionId}
            >
              Or describe the job
            </Label>
            <Textarea
              className="min-h-[120px]"
              id={descriptionId}
              maxLength={DESCRIPTION_LIMIT}
              onChange={handleDescription}
              value={description}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Button
              aria-describedby={hasKey ? undefined : hintId}
              disabled={!canContinue}
              onClick={onContinue}
              type="button"
            >
              Continue to the builder
            </Button>
            {hasKey ? null : (
              <p className="text-muted-foreground text-xs" id={hintId}>
                {NEEDS_KEY_HINT}
              </p>
            )}
          </div>
        </li>
      </ol>
    </section>
  );
};
