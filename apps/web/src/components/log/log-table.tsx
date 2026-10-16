import { Link } from "@tanstack/react-router";
import { Badge } from "#/components/ui/badge.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table.tsx";
import type { EventLogEntry } from "#/integrations/trpc/types";

interface LogTableProps {
  agentNames: ReadonlyMap<string, string>;
  entries: readonly EventLogEntry[];
}

interface LogRowProps {
  agentName: string;
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

function LogRow({ agentName, entry }: LogRowProps) {
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
      </TableCell>
    </TableRow>
  );
}

export function LogTable({ agentNames, entries }: LogTableProps) {
  if (entries.length === 0) {
    return <p className="text-muted-foreground text-sm">No events.</p>;
  }
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
            entry={entry}
            key={entry.id}
          />
        ))}
      </TableBody>
    </Table>
  );
}
