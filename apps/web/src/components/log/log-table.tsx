import { Link, useRouter } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import type { EventLogEntry } from "#/integrations/trpc/types";
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
    <Button
      className="ml-2"
      data-testid="log-cancel"
      disabled={cancelling}
      onClick={cancel}
      size="sm"
      variant="outline"
    >
      Cancel
    </Button>
  );
}

function LogRow({ agentName, cancellable, entry }: LogRowProps) {
  const hasLinks = entry.sessionId !== null || entry.runId !== null;
  return (
    <TableRow data-testid="log-row">
      <TableCell className="whitespace-nowrap">
        <time dateTime={entry.createdAt}>{formatUtc(entry.createdAt)}</time>
      </TableCell>
      <TableCell>
        <Badge variant="secondary">{entry.type}</Badge>
      </TableCell>
      <TableCell>{agentName}</TableCell>
      <TableCell className="max-w-md truncate">
        {entry.summary === "" ? "-" : entry.summary}
      </TableCell>
      <TableCell className="whitespace-nowrap">
        {hasLinks ? null : "-"}
        {entry.sessionId === null ? null : (
          <Link
            className="mr-2 hover:underline"
            data-testid="log-session-link"
            search={{ session: entry.sessionId }}
            to="/sessions"
          >
            Session
          </Link>
        )}
        {entry.runId === null ? null : (
          <span className="text-muted-foreground text-xs" title={entry.runId}>
            Run {entry.runId.slice(-8)}
          </span>
        )}
        {entry.runId !== null && cancellable ? (
          <CancelRunButton runId={entry.runId} />
        ) : null}
      </TableCell>
    </TableRow>
  );
}

export function LogTable({ agentNames, entries }: LogTableProps) {
  if (entries.length === 0) {
    return <p className="text-muted-foreground text-sm">No events.</p>;
  }
  const cancellable = cancelEntryIds(entries);
  return (
    <Table>
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
    </Table>
  );
}
