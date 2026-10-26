import { type ReactNode, useCallback } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "#/components/ui/sheet.tsx";
import type { AgentRecord } from "#/integrations/trpc/types";
import { SHEET_TITLES, type SheetId } from "./sheet-ids.ts";
import { AdvancedPanel } from "./sheets/advanced.tsx";
import { ConnectorsPanel } from "./sheets/connectors.tsx";
import { HandsToPanel } from "./sheets/hands-to.tsx";
import { RoutinesPanel } from "./sheets/routines.tsx";
import { SecretsPanel } from "./sheets/secrets.tsx";
import { SkillsPanel } from "./sheets/skills.tsx";
import { SlackPanel } from "./sheets/slack.tsx";
import { TriggersPanel } from "./sheets/triggers.tsx";

const SECTION_CLASS = "flex flex-col gap-8";

function Section({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="font-heading text-foreground text-lg">{title}</h3>
      {children}
    </section>
  );
}

function SheetBody({ agent, sheet }: { agent: AgentRecord; sheet: SheetId }) {
  switch (sheet) {
    case "tools":
      return (
        <div className={SECTION_CLASS}>
          <Section title="Connectors">
            <ConnectorsPanel agent={agent} />
          </Section>
          <Section title="Secrets">
            <SecretsPanel agent={agent} />
          </Section>
        </div>
      );
    case "skills":
      return <SkillsPanel agent={agent} />;
    case "handsTo":
      return <HandsToPanel agent={agent} />;
    case "startsOn":
      return (
        <div className={SECTION_CLASS}>
          <Section title="Triggers">
            <TriggersPanel agent={agent} />
          </Section>
          <Section title="Routines">
            <RoutinesPanel agent={agent} />
          </Section>
        </div>
      );
    case "channels":
      return <SlackPanel agent={agent} />;
    case "edit":
      return <AdvancedPanel agent={agent} />;
    default:
      return null;
  }
}

/** The side sheet that holds one manage panel. `sheet` is undefined while it is closed. */
export function ManageSheet({
  agent,
  onClose,
  sheet,
}: {
  agent: AgentRecord;
  onClose: () => void;
  sheet: SheetId | undefined;
}): ReactNode {
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        onClose();
      }
    },
    [onClose]
  );
  return (
    <Sheet onOpenChange={handleOpenChange} open={sheet !== undefined}>
      <SheetContent className="data-[side=right]:sm:max-w-3xl" side="right">
        <SheetHeader>
          <SheetTitle>
            {sheet === undefined ? "" : SHEET_TITLES[sheet]}
          </SheetTitle>
          <SheetDescription>{agent.name}</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-4 pb-6">
          {sheet === undefined ? null : (
            <SheetBody agent={agent} sheet={sheet} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
