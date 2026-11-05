import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#/components/ui/collapsible.tsx";
import { groupLabel } from "./tool-card-logic.ts";

export function OutsideInput({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="w-full border border-l-4 border-l-muted-foreground bg-card p-3">
      <p className="mb-2 text-muted-foreground text-xs">{label}</p>
      <div className="whitespace-pre-wrap text-sm">{children}</div>
    </div>
  );
}

const MODEL_PROVIDERS = /model.providers/i;

export function RunFailure({ error }: { error: string }) {
  return (
    <div
      className="border border-destructive/50 bg-destructive/10 p-3 text-sm"
      role="alert"
    >
      <h3 className="mb-2 font-medium text-destructive">Run failed</h3>
      <pre className="whitespace-pre-wrap break-words font-mono text-xs">
        {error}
      </pre>
      {MODEL_PROVIDERS.test(error) ? (
        <a
          className="mt-2 inline-flex min-h-10 items-center border px-3 underline focus-visible:ring-2 focus-visible:ring-ring md:min-h-9"
          href="/settings/model-providers"
        >
          Model providers
        </a>
      ) : null}
    </div>
  );
}

export function ToolGroup({
  names,
  running,
  children,
}: {
  names: string[];
  running: boolean;
  children?: ReactNode;
}) {
  return (
    <Collapsible
      className="border px-3 text-xs"
      data-testid="tool-group"
      defaultOpen={running}
      key={String(running)}
    >
      <CollapsibleTrigger className="group flex min-h-10 w-full items-center gap-1.5 text-left md:min-h-9">
        <ChevronRightIcon
          aria-hidden="true"
          className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90"
        />
        <span className="min-w-0 flex-1 truncate font-medium">
          {groupLabel(names)}
        </span>
        <span className="shrink-0 text-muted-foreground">
          {names.length} tool {names.length === 1 ? "call" : "calls"}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mb-2 flex flex-col gap-1.5">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

const CONFLICT_COUNT = /([0-9]+ conflicts?)/;
export function FilesLine({
  text,
  onOpen,
  onConflicts,
}: {
  text: string;
  onOpen: () => void;
  onConflicts?: () => void;
}) {
  const pieces = text.split(CONFLICT_COUNT);
  return (
    <p className="text-muted-foreground text-xs">
      {pieces.map((piece, index) =>
        index % 2 === 1 ? (
          <button
            className="min-h-10 text-warning underline focus-visible:ring-2 focus-visible:ring-ring md:min-h-9"
            key={piece}
            onClick={onConflicts ?? onOpen}
            type="button"
          >
            {piece}
          </button>
        ) : (
          piece
        )
      )}{" "}
      ·{" "}
      <button
        className="min-h-10 text-foreground underline focus-visible:ring-2 focus-visible:ring-ring md:min-h-9"
        onClick={onOpen}
        type="button"
      >
        See files
      </button>
    </p>
  );
}
