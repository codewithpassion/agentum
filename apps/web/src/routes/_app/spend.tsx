import { createFileRoute, Link } from "@tanstack/react-router";
import { SpendChart } from "#/components/spend/spend-chart";
import {
  buildSpendTable,
  capLine,
  spendRange,
  spendWeeks,
} from "#/components/spend/spend-logic";
import { SpendTableView } from "#/components/spend/spend-table";
import { buttonVariants } from "#/components/ui/button";
import { getTrpc } from "#/integrations/trpc/client";
import { loadOrLogin } from "#/integrations/trpc/load-or-login";

export const PAGE_HEADING = "Spend";

export const Route = createFileRoute("/_app/spend")({
  loader: async () =>
    loadOrLogin(async () => {
      const trpc = getTrpc();
      const { timezone } = await trpc.workspaces.timezone.query();
      const weeks = spendWeeks(new Date(), timezone);
      const [rows, caps, agents] = await Promise.all([
        trpc.spend.workspace.query(spendRange(weeks)),
        trpc.spend.caps.query(),
        trpc.agents.list.query({ includeArchived: true }),
      ]);
      return {
        table: buildSpendTable({
          agents,
          caps: caps.agents,
          rows,
          weeks,
        }),
        weeks,
        workspaceCapCents: caps.workspaceCapCents,
      };
    }),
  component: SpendPage,
});

function SpendPage() {
  const { table, weeks, workspaceCapCents } = Route.useLoaderData();
  const thisWeek = table.totals.at(-1) ?? 0;
  const line = capLine(thisWeek, workspaceCapCents);
  return (
    <section className="mx-auto flex max-w-5xl flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl text-foreground">
            {PAGE_HEADING}
          </h1>
          <p className="text-muted-foreground text-sm" data-testid="spend-line">
            {line === null
              ? "No workspace limit is set."
              : `Workspace: ${line}.`}
          </p>
        </div>
        <Link
          className={buttonVariants({ variant: "outline" })}
          to="/settings/spend"
        >
          Set a limit
        </Link>
      </header>
      <div className="rounded-xl border border-border bg-card p-4">
        <h2 className="mb-2 font-heading text-foreground text-lg">
          Spend per week
        </h2>
        <SpendChart
          capCents={workspaceCapCents}
          totals={table.totals}
          weeks={weeks}
        />
      </div>
      <SpendTableView table={table} weeks={weeks} />
    </section>
  );
}
