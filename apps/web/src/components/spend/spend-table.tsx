import { Link } from "@tanstack/react-router";
import { weekCostLabel } from "#/components/roster/roster-logic.ts";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import { capLabel, type SpendTable, type SpendWeek } from "./spend-logic.ts";

export function SpendTableView({
  table,
  weeks,
}: {
  table: SpendTable;
  weeks: readonly SpendWeek[];
}) {
  if (table.rows.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No spend in the last five weeks.
      </p>
    );
  }
  return (
    <Table>
      <TableCaption className="sr-only">
        Spend per agent, this week and the four weeks before
      </TableCaption>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Agent</TableHead>
          {weeks.map((week) => (
            <TableHead className="text-right" key={week.start}>
              {week.label}
            </TableHead>
          ))}
          <TableHead className="text-right">Limit</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {table.rows.map((row) => (
          <TableRow key={row.agentId}>
            <TableCell>
              {row.removed ? (
                <span className="font-medium text-muted-foreground">
                  {row.name}
                </span>
              ) : (
                <Link
                  className="font-medium text-foreground no-underline hover:text-primary"
                  params={{ agentId: row.agentId }}
                  to="/agents/$agentId"
                >
                  {row.name}
                </Link>
              )}
              {row.paused ? (
                <span className="ml-2 rounded border px-1.5 py-0.5 text-muted-foreground text-xs">
                  Paused
                </span>
              ) : null}
            </TableCell>
            {weeks.map((week, index) => (
              <TableCell className="text-right tabular-nums" key={week.start}>
                {weekCostLabel(row.centsByWeek[index] ?? 0)}
              </TableCell>
            ))}
            <TableCell className="text-right tabular-nums">
              {row.capCents === null ? (
                <span className="text-muted-foreground">None</span>
              ) : (
                capLabel(row.capCents)
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell className="font-medium">Total</TableCell>
          {weeks.map((week, index) => (
            <TableCell
              className="text-right font-medium tabular-nums"
              key={week.start}
            >
              {weekCostLabel(table.totals[index] ?? 0)}
            </TableCell>
          ))}
          <TableCell />
        </TableRow>
      </TableFooter>
    </Table>
  );
}
