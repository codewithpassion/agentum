import { Link, useRouter } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { ConfirmButton } from "#/components/confirm-action/confirm-button";
import {
  ResponsiveActions,
  ResponsiveCell,
  ResponsiveTable,
} from "#/components/responsive-table/responsive-table";
import { Badge } from "#/components/ui/badge.tsx";
import {
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import type { EventLogEntry } from "#/integrations/trpc/types";
import { cn } from "#/lib/utils";
import { cancelEntryIds } from "./log-logic.ts";

interface LogTableProps {
  agentNames: ReadonlyMap<string, string>;
  entries: readonly EventLogEntry[];
}

interface LogRowProps {
  agentName: string;
  cancellable: boolean;
  entry: EventLogEntry;
}

/** The stored UTC time as `2026-02-02 12:00:00 UTC`, the same on the server and in the browser, and in the day the date filter uses. */
const formatUtc = (iso: string): string =>
  `${iso.slice(0, 19).replace("T", " ")} UTC`;

function agentLabel(
  entry: EventLogEntry,
  agentNames: ReadonlyMap<string, string>
): string {
  if (entry.agentId === null) {
    return "-";
  }
  return agentNames.get(entry.agentId) ?? "Agent";
}

const CANCEL_FAILED = "Could not cancel the run.";

/** Shows the "Links" label beside the actions cell in the phone card, as ResponsiveCell does for its cells. */
const LINKS_LABEL_CLASS =
  "max-md:before:content-[attr(data-label)] max-md:before:shrink-0 max-md:before:text-left max-md:before:font-medium max-md:before:text-muted-foreground max-md:before:text-xs";

function CancelRunButton({ runId }: { runId: string }) {
  const router = useRouter();
  const [cancelling, setCancelling] = useState(false);
  const cancel = useCallback(async () => {
    setCancelling(true);
    try {
      await getTrpc().runs.cancel.mutate({ runId });
      await router.invalidate();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : CANCEL_FAILED);
    } finally {
      setCancelling(false);
    }
  }, [router, runId]);
  return (
    <ConfirmButton
      className="ml-2"
      confirmLabel="Cancel run"
      data-testid="log-cancel"
      description="The run stops now. Work it has not finished is lost."
      disabled={cancelling}
      onConfirm={cancel}
      size="sm"
      title="Cancel this run?"
      variant="outline"
    >
      Cancel
    </ConfirmButton>
  );
}

function TaskLink({ runId }: { runId: string }) {
  const params = useMemo(() => ({ runId }), [runId]);
  return (
    <Link
      className="mr-2 hover:underline"
      data-testid="log-task-link"
      params={params}
      title={runId}
      to="/tasks/$runId"
    >
      Task {runId.slice(-8)}
    </Link>
  );
}

function LogRow({ agentName, cancellable, entry }: LogRowProps) {
  return (
    <TableRow data-testid="log-row">
      <ResponsiveCell className="whitespace-nowrap" label="Time">
        <time dateTime={entry.createdAt}>{formatUtc(entry.createdAt)}</time>
      </ResponsiveCell>
      <ResponsiveCell label="Type">
        <Badge variant="secondary">{entry.type}</Badge>
      </ResponsiveCell>
      <ResponsiveCell label="Agent">{agentName}</ResponsiveCell>
      <ResponsiveCell className="md:max-w-md md:truncate" label="Summary">
        {entry.summary === "" ? "-" : entry.summary}
      </ResponsiveCell>
      <ResponsiveActions
        className={cn("whitespace-nowrap", LINKS_LABEL_CLASS)}
        data-label="Links"
      >
        {entry.runId === null ? "-" : <TaskLink runId={entry.runId} />}
        {entry.runId !== null && cancellable ? (
          <CancelRunButton runId={entry.runId} />
        ) : null}
      </ResponsiveActions>
    </TableRow>
  );
}

export function LogTable({ agentNames, entries }: LogTableProps) {
  if (entries.length === 0) {
    return <p className="text-muted-foreground text-sm">No events.</p>;
  }
  const cancellable = cancelEntryIds(entries);
  return (
    <ResponsiveTable>
      <TableHeader>
        <TableRow>
          <TableHead>Time</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Agent</TableHead>
          <TableHead>Summary</TableHead>
          <TableHead>Links</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry) => (
          <LogRow
            agentName={agentLabel(entry, agentNames)}
            cancellable={cancellable.has(entry.id)}
            entry={entry}
            key={entry.id}
          />
        ))}
      </TableBody>
    </ResponsiveTable>
  );
}
