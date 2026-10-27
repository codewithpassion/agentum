import type { ComponentProps } from "react";
import { Table, TableCell } from "#/components/ui/table";
import { cn } from "#/lib/utils";

/**
 * Below the `md` breakpoint the table renders each row as a stacked card.
 * Every cell shows its `label` (from `data-label`) beside its value, and the
 * header row is hidden visually. From `md` up it is the plain table.
 */
const CARD_LAYOUT = [
  "max-md:[&_table]:block",
  "max-md:[&_thead]:sr-only",
  "max-md:[&_tbody]:block",
  "max-md:[&_tr]:block max-md:[&_tr]:space-y-1 max-md:[&_tr]:border-b max-md:[&_tr]:py-3",
].join(" ");

export function ResponsiveTable({
  className,
  ...props
}: ComponentProps<typeof Table>) {
  return (
    <div className={cn("w-full", CARD_LAYOUT)}>
      <Table className={className} {...props} />
    </div>
  );
}

const CELL_CARD_LAYOUT = [
  "max-md:flex max-md:items-start max-md:justify-between max-md:gap-3",
  "max-md:px-0 max-md:py-1 max-md:text-right max-md:whitespace-normal",
  "max-md:[overflow-wrap:anywhere] max-md:empty:hidden",
  "max-md:before:shrink-0 max-md:before:text-left max-md:before:font-medium",
  "max-md:before:text-muted-foreground max-md:before:text-xs",
  "max-md:before:content-[attr(data-label)]",
].join(" ");

/** A table cell that shows `label` next to its value in the phone card. */
export function ResponsiveCell({
  className,
  label,
  ...props
}: ComponentProps<typeof TableCell> & { label: string }) {
  return (
    <TableCell
      className={cn(CELL_CARD_LAYOUT, className)}
      data-label={label}
      {...props}
    />
  );
}

const ACTIONS_CARD_LAYOUT = [
  "max-md:flex max-md:flex-wrap max-md:items-center max-md:justify-start max-md:gap-2 max-md:px-0 max-md:pt-2",
  "max-md:empty:hidden",
  "max-md:[&_a]:min-h-10 max-md:[&_button]:min-h-10 max-md:[&_button]:min-w-10",
].join(" ");

/** The last cell of a row: its buttons wrap and are 40px tall on phones. */
export function ResponsiveActions({
  className,
  ...props
}: ComponentProps<typeof TableCell>) {
  return (
    <TableCell className={cn(ACTIONS_CARD_LAYOUT, className)} {...props} />
  );
}
