import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#/components/ui/collapsible.tsx";

/** A section that stays closed until the person opens it. */
export function Disclosure({
  children,
  className,
  defaultOpen,
  summary,
  title,
}: {
  children: ReactNode;
  className?: string;
  /** Open from the start. An archived agent has its page disabled, which a closed trigger would not survive. */
  defaultOpen?: boolean;
  /** A short line after the title that says what is inside. */
  summary?: string;
  title: string;
}) {
  return (
    <Collapsible className={className} defaultOpen={defaultOpen}>
      <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-1.5 py-2.5 text-left">
        <ChevronRight
          aria-hidden
          className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-90"
        />
        <span className="shrink-0 font-semibold text-sm">{title}</span>
        {summary === undefined ? null : (
          <span className="min-w-0 text-muted-foreground text-xs">
            {summary}
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}
