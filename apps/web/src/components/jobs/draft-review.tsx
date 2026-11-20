import type { ProposedTrigger } from "@repo/db/shared";
import {
  CHIP_CLASS,
  TONE_CLASS,
} from "#/components/agent/profile/chip-list.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
  type DraftSaveKind,
  draftChips,
  draftSaveKind,
  type JobChip,
  type JobChipKind,
} from "./job-logic.ts";

const SENTENCE_CHIP_CLASS = `inline-flex rounded-full border px-2.5 py-0.5 text-sm whitespace-normal [overflow-wrap:anywhere] ${TONE_CLASS.default}`;

const NOTE_BY_SAVE_KIND: Record<DraftSaveKind, string | null> = {
  http: "Saving gives you a web address and a secret. Anything that calls it starts this agent.",
  mail: "Mail starts are set up under Keys. Open Keys to turn on this agent's mail address.",
  routine: null,
  unsupported: "This kind of job cannot be saved here.",
};

const chipClassName = (kind: JobChipKind): string => {
  if (kind === "does") {
    return SENTENCE_CHIP_CLASS;
  }
  if (kind === "when") {
    return `${CHIP_CLASS} ${TONE_CLASS.on}`;
  }
  return `${CHIP_CLASS} ${TONE_CLASS.default}`;
};

const scheduleText = (
  cron: string | null,
  timezone: string | null
): string | null => {
  if (cron === null) {
    return null;
  }
  return timezone === null ? cron : `${cron} (${timezone})`;
};

const ChipRow = ({ chips }: { chips: readonly JobChip[] }) => (
  <div className="flex flex-wrap items-center gap-1.5">
    {chips.map((chip) => (
      <span
        className={chipClassName(chip.kind)}
        data-chip={chip.kind}
        key={chip.kind}
      >
        {chip.text}
      </span>
    ))}
  </div>
);

export function DraftReview({
  draft,
  agentName,
  saving,
  error,
  onSave,
  onEdit,
  onDiscard,
  onOpenKeys,
}: {
  draft: ProposedTrigger;
  /** Shown after the heading when the list covers several agents. */
  agentName?: string;
  saving: boolean;
  error: string | null;
  onSave: () => void;
  /** Opens the routine form prefilled. Shown only for a routine draft. */
  onEdit: () => void;
  onDiscard: () => void;
  /** Opens Keys, where a mail start is set up. */
  onOpenKeys: () => void;
}) {
  const saveKind = draftSaveKind(draft);
  const schedule = scheduleText(
    draft.source === "routine" ? draft.cron : null,
    draft.timezone
  );
  const note = NOTE_BY_SAVE_KIND[saveKind];

  return (
    <section
      aria-label="Draft job"
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-primary/40 bg-primary/5 p-3"
    >
      <h3 className="font-heading text-base">
        Review this job
        {agentName === undefined ? null : (
          <span className="text-muted-foreground text-sm">
            {` for ${agentName}`}
          </span>
        )}
      </h3>
      <ChipRow chips={draftChips(draft)} />
      {schedule === null ? null : (
        <p className="font-mono text-muted-foreground text-xs">{schedule}</p>
      )}
      {note === null ? null : (
        <p className="text-muted-foreground text-sm">{note}</p>
      )}
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {saveKind === "routine" || saveKind === "http" ? (
          <Button disabled={saving} onClick={onSave} type="button">
            {saving ? "Saving..." : "Save job"}
          </Button>
        ) : null}
        {saveKind === "routine" ? (
          <Button onClick={onEdit} type="button" variant="outline">
            Edit first
          </Button>
        ) : null}
        {saveKind === "mail" ? (
          <Button onClick={onOpenKeys} type="button" variant="outline">
            Open Keys
          </Button>
        ) : null}
        <Button onClick={onDiscard} type="button" variant="outline">
          Discard
        </Button>
      </div>
    </section>
  );
}
