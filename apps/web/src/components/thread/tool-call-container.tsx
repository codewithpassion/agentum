import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { useAuiState } from "@assistant-ui/react";
import {
  ChevronRightIcon,
  FileTextIcon,
  GlobeIcon,
  SparklesIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#/components/ui/collapsible.tsx";
import { Spinner } from "#/components/ui/spinner.tsx";
import { ToolGroup } from "./thread-cards.tsx";
import {
  type ToolCardInfo,
  type ToolKind,
  toolCardInfo,
} from "./tool-card-logic.ts";

const ICONS: Record<ToolKind, typeof WrenchIcon> = {
  command: TerminalIcon,
  file: FileTextIcon,
  generic: WrenchIcon,
  skill: SparklesIcon,
  web: GlobeIcon,
};

function ToolSection({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <p className="font-medium">{label}</p>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap">{text}</pre>
    </div>
  );
}

function StateMark({ state }: { state: ToolCardInfo["state"] }) {
  if (state === "running") {
    return <Spinner className="size-3.5" />;
  }
  return state === "failed" ? (
    <Badge variant="destructive">failed</Badge>
  ) : null;
}

/** One tool call as a card: kind icon, name, what it did, and its input and output on open. */
export function ToolCard({ info }: { info: ToolCardInfo }) {
  const Icon = ICONS[info.kind];
  const hasDetails = info.input !== null || info.output !== null;
  return (
    <Collapsible
      className="rounded-md border px-3 py-1.5 text-xs"
      data-kind={info.kind}
      data-testid="tool-card"
    >
      <CollapsibleTrigger
        className="group flex min-h-10 w-full items-center gap-2 text-left md:min-h-9"
        disabled={!hasDetails}
      >
        <Icon aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="shrink-0 font-medium">{info.title}</span>
        {info.subtitle === null ? null : (
          <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
            {info.subtitle}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <StateMark state={info.state} />
          {hasDetails ? (
            <ChevronRightIcon
              aria-hidden="true"
              className="size-3.5 transition-transform group-data-[state=open]:rotate-90"
            />
          ) : null}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 flex flex-col gap-2 text-muted-foreground">
        {info.input === null ? null : (
          <ToolSection label="Input" text={info.input} />
        )}
        {info.output === null ? null : (
          <ToolSection label="Output" text={info.output} />
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

const nonEmpty = (args: unknown): boolean =>
  typeof args === "object" && args !== null && Object.keys(args).length > 0;

/** The renderer for every tool call part. */
export function ToolCallContainer({
  args,
  argsText,
  isError,
  result,
  toolName,
}: ToolCallMessagePartProps) {
  let input: unknown = null;
  if (nonEmpty(args)) {
    input = args;
  } else if (argsText !== undefined && argsText !== "{}") {
    input = argsText;
  }
  const ok = result === undefined ? null : isError !== true;
  return (
    <ToolCard info={toolCardInfo({ input, name: toolName, ok, result })} />
  );
}

const NAME_SEPARATOR = "\u0000";

/**
 * A run of consecutive tool calls. One call shows as its plain card. Several
 * collapse under a "name ×n" line, so ten reads of a file do not fill the thread.
 */
export function ToolGroupContainer({
  children,
  endIndex,
  startIndex,
}: {
  children?: ReactNode;
  endIndex: number;
  startIndex: number;
}) {
  const joined = useAuiState((state) =>
    state.message.parts
      .slice(startIndex, endIndex + 1)
      .map((part) => (part.type === "tool-call" ? part.toolName : ""))
      .join(NAME_SEPARATOR)
  );
  const running = useAuiState(
    (state) => state.message.status?.type === "running"
  );
  return (
    <ToolGroup names={joined.split(NAME_SEPARATOR)} running={running}>
      {children}
    </ToolGroup>
  );
}
