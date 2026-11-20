import { AGENT_TEMPLATE_IDS, type AgentTemplateId } from "@repo/db/shared";
import { templates } from "@repo/services/agent-builder/templates";
import { useCallback } from "react";

const FIRST_SENTENCE = /^[\s\S]*?\.(?=\s|$)/;

/** The first sentence of a template description, or the whole text when it has no period. */
export const templateLine = (description: string): string => {
  const match = FIRST_SENTENCE.exec(description);
  return (match?.[0] ?? description).trim();
};

function TemplateCard({
  busy,
  id,
  onPick,
}: {
  busy: boolean;
  id: AgentTemplateId;
  onPick: (id: AgentTemplateId) => void;
}) {
  const handleClick = useCallback(() => onPick(id), [id, onPick]);
  const template = templates[id];
  return (
    <button
      className="flex min-h-10 flex-col gap-1 rounded-lg border border-border bg-card p-3 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      disabled={busy}
      onClick={handleClick}
      type="button"
    >
      <span className="font-medium text-sm">{template.title}</span>
      <span className="block text-muted-foreground text-xs">
        {templateLine(template.description)}
      </span>
    </button>
  );
}

export function TemplateGallery({
  busy,
  onPick,
}: {
  busy: boolean;
  onPick: (id: AgentTemplateId) => void;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-medium text-sm">Start from a template</h2>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {AGENT_TEMPLATE_IDS.map((id) => (
          <TemplateCard busy={busy} id={id} key={id} onPick={onPick} />
        ))}
      </div>
    </section>
  );
}
