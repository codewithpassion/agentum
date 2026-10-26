import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Markdown } from "#/components/markdown/markdown.tsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#/components/ui/collapsible.tsx";

/** One reasoning part. The group around it owns the collapsing. */
export function ReasoningPart({ text }: { text: string }) {
  return (
    <div className="text-muted-foreground text-xs">
      <Markdown>{text}</Markdown>
    </div>
  );
}

/** A run of reasoning parts, collapsed until the person opens it. */
export function ReasoningContainer({ children }: { children?: ReactNode }) {
  return (
    <Collapsible
      className="rounded-md border px-3 py-1.5"
      data-testid="reasoning"
    >
      <CollapsibleTrigger className="group flex w-full items-center gap-1.5 text-muted-foreground text-xs">
        <ChevronRightIcon
          aria-hidden="true"
          className="size-3.5 transition-transform group-data-[state=open]:rotate-90"
        />
        Reasoning
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-1.5">{children}</CollapsibleContent>
    </Collapsible>
  );
}
