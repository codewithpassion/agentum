import { Link } from "@tanstack/react-router";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import type { AgentTableRow } from "./agents-table-logic.ts";

export function AgentsTable({ rows }: { rows: AgentTableRow[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Name</TableHead>
          <TableHead>Asks</TableHead>
          <TableHead>Doing now</TableHead>
          <TableHead className="text-right">Tasks this week</TableHead>
          <TableHead className="text-right">Cost this week</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(({ agent, asked, cost, doing, tasksThisWeek }) => (
          <TableRow key={agent.id}>
            <TableCell>
              <Link
                className="font-medium text-foreground no-underline hover:text-primary"
                params={{ agentId: agent.id }}
                to="/agents/$agentId"
              >
                {agent.name}
              </Link>
              <div className="text-muted-foreground text-xs">
                <code>{agent.slug}</code>
              </div>
            </TableCell>
            <TableCell>{asked}</TableCell>
            <TableCell>
              {doing.map((segment, index) => (
                <span
                  className={
                    segment.strong ? "text-foreground" : "text-muted-foreground"
                  }
                  key={segment.text}
                >
                  {index > 0 ? ", " : null}
                  {segment.text}
                </span>
              ))}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {tasksThisWeek}
            </TableCell>
            <TableCell className="text-right text-muted-foreground tabular-nums">
              {cost}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
