import {
  AGENT_TEMPLATE_IDS,
  type AgentTemplateId,
  VOICE_PRESETS,
  type VoicePreset,
} from "@repo/db/shared";
import { templates } from "@repo/services/agent-builder/templates";
import { Link } from "@tanstack/react-router";
import { type ChangeEvent, useCallback, useId, useRef, useState } from "react";
import { Alert, AlertDescription } from "#/components/ui/alert";
import { Button } from "#/components/ui/button";
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";
import {
  type BuilderStep,
  DESCRIPTION_LIMIT,
  importFileError,
  importTextError,
  isNoKeyError,
} from "./builder-logic.ts";

const CHIP_CLASS =
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs";
const CHIP_DEFAULT = "border-border bg-background text-foreground";
const CHIP_ON = "border-primary bg-primary/10 text-primary";
const CHIP_ADD = "border-dashed text-muted-foreground hover:text-foreground";
const CHECK_MARK = "✓";
const IMPORT_ACCEPT = ".md,.txt,text/plain,text/markdown";

const capitalise = (word: string): string =>
  word.charAt(0).toUpperCase() + word.slice(1);

const draftLabel = (busy: boolean, hasDraft: boolean): string => {
  if (busy) {
    return "Drafting...";
  }
  return hasDraft ? "Redraft" : "Draft";
};

function ChipButton<T extends string>({
  className,
  label,
  onPick,
  pressed,
  value,
}: {
  className: string;
  label: string;
  onPick: (value: T) => void;
  /** Set for toggle chips. Omitted for plain action chips. */
  pressed?: boolean;
  value: T;
}) {
  const handleClick = useCallback(() => onPick(value), [onPick, value]);
  return (
    <button
      aria-pressed={pressed}
      className={`${CHIP_CLASS} ${className}`}
      onClick={handleClick}
      type="button"
    >
      {label}
    </button>
  );
}

export interface DescribePanelProps {
  /** A draft request is running. */
  busy: boolean;
  description: string;
  /** A failed draft, shown in a destructive Alert. */
  error: string | null;
  /** The button reads "Redraft" when true, else "Draft". */
  hasDraft: boolean;
  onDescription: (text: string) => void;
  onDraft: () => void;
  /** The page fills the box and the voice. */
  onTemplate: (id: AgentTemplateId) => void;
  onVoice: (voice: VoicePreset) => void;
  /** Empty before the first draft. */
  steps: BuilderStep[];
  voice: VoicePreset | undefined;
}

/** The left column of the builder: the description, the voice, and what the builder did. */
export function DescribePanel({
  busy,
  description,
  error,
  hasDraft,
  onDescription,
  onDraft,
  onTemplate,
  onVoice,
  steps,
  voice,
}: DescribePanelProps) {
  const descriptionId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [importMessage, setImportMessage] = useState<string | null>(null);

  const openFilePicker = useCallback(() => fileInput.current?.click(), []);

  const handleDescription = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) =>
      onDescription(event.currentTarget.value),
    [onDescription]
  );

  const handleFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const input = event.currentTarget;
      const file = input.files?.[0];
      // Clear the input so the same file can be chosen again.
      input.value = "";
      if (file === undefined) {
        return;
      }
      const fileProblem = importFileError(file);
      if (fileProblem !== null) {
        setImportMessage(fileProblem);
        return;
      }
      const text = await file.text();
      const textProblem = importTextError(text);
      if (textProblem !== null) {
        setImportMessage(textProblem);
        return;
      }
      setImportMessage(null);
      onDescription(text);
    },
    [onDescription]
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
        <div className="flex flex-col gap-2">
          <Label
            className="text-muted-foreground text-xs uppercase tracking-wide"
            htmlFor={descriptionId}
          >
            1 · What should it do?
          </Label>
          <Textarea
            className="min-h-[150px]"
            id={descriptionId}
            maxLength={DESCRIPTION_LIMIT}
            onChange={handleDescription}
            value={description}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label className="text-muted-foreground text-xs uppercase tracking-wide">
            Or start from
          </Label>
          <div className="flex flex-wrap items-center gap-1.5">
            {AGENT_TEMPLATE_IDS.map((id) => (
              <ChipButton<AgentTemplateId>
                className={CHIP_DEFAULT}
                key={id}
                label={templates[id].title}
                onPick={onTemplate}
                value={id}
              />
            ))}
            <ChipButton<string>
              className={CHIP_ADD}
              label="Import from a file"
              onPick={openFilePicker}
              value="import"
            />
            <input
              accept={IMPORT_ACCEPT}
              className="hidden"
              onChange={handleFile}
              ref={fileInput}
              type="file"
            />
          </div>
          {importMessage === null ? null : (
            <p className="text-destructive text-xs">{importMessage}</p>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <Label className="text-muted-foreground text-xs uppercase tracking-wide">
            2 · How should it write?
          </Label>
          <div className="flex flex-wrap items-center gap-1.5">
            {VOICE_PRESETS.map((preset) => (
              <ChipButton<VoicePreset>
                className={preset === voice ? CHIP_ON : CHIP_DEFAULT}
                key={preset}
                label={capitalise(preset)}
                onPick={onVoice}
                pressed={preset === voice}
                value={preset}
              />
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            disabled={busy || description.trim() === ""}
            onClick={onDraft}
            type="button"
          >
            {draftLabel(busy, hasDraft)}
          </Button>
          {hasDraft ? (
            <span className="text-muted-foreground text-xs">
              Edits on the right are kept.
            </span>
          ) : null}
        </div>

        {error === null ? null : (
          <Alert variant="destructive">
            <AlertDescription>
              {error}
              {isNoKeyError(error) ? (
                <>
                  {" "}
                  <Link
                    className="underline underline-offset-4"
                    to="/settings/model-providers"
                  >
                    Open Settings
                  </Link>
                </>
              ) : null}
            </AlertDescription>
          </Alert>
        )}
      </div>

      {steps.length > 0 ? (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
          <h2 className="font-medium text-sm">What the builder did</h2>
          <ul className="flex flex-col gap-2">
            {steps.map((step) => (
              <li className="flex items-center gap-2 text-sm" key={step.label}>
                <span
                  className={`flex size-4 shrink-0 items-center justify-center rounded-sm border text-[10px] leading-none ${
                    step.done
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border"
                  }`}
                >
                  {step.done ? CHECK_MARK : null}
                </span>
                {step.label}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
