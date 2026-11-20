import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import { weekCostLabel } from "#/components/roster/roster-logic.ts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "#/components/ui/chart.tsx";
import { capLabel, type SpendWeek } from "./spend-logic.ts";

const CENTS_PER_DOLLAR = 100;
const CHART_COLOR = "var(--chart-1)";
const EARLIER_WEEK_OPACITY = 0.45;

const chartConfig = {
  dollars: { color: CHART_COLOR, label: "Spend" },
} satisfies ChartConfig;

export interface SpendChartPoint {
  cents: number;
  current: boolean;
  dollars: number;
  label: string;
}

/** One point per week, oldest first. A missing total counts as zero. */
export const chartData = (
  weeks: readonly SpendWeek[],
  totals: readonly number[]
): SpendChartPoint[] =>
  weeks.map((week, index) => {
    const cents = totals[index] ?? 0;
    return {
      cents,
      current: index === weeks.length - 1,
      dollars: cents / CENTS_PER_DOLLAR,
      label: week.label,
    };
  });

const formatDollars = (dollars: number): string =>
  weekCostLabel(dollars * CENTS_PER_DOLLAR);

const formatDollarValue = (value: unknown): string =>
  formatDollars(Number(value));

export function SpendChart({
  capCents,
  totals,
  weeks,
}: {
  capCents: number | null;
  totals: readonly number[];
  weeks: readonly SpendWeek[];
}) {
  const data = chartData(weeks, totals);
  const currentCents = data.at(-1)?.cents ?? 0;
  const summary = `Spend per week, this week ${weekCostLabel(currentCents)}`;

  return (
    <div aria-label={summary} role="img">
      <ChartContainer className="h-56 w-full" config={chartConfig}>
        <BarChart data={data} margin={{ top: 24 }}>
          <CartesianGrid vertical={false} />
          <XAxis
            axisLine={false}
            dataKey="label"
            tickLine={false}
            tickMargin={8}
          />
          <YAxis hide />
          <ChartTooltip
            content={<ChartTooltipContent formatter={formatDollarValue} />}
          />
          <Bar
            dataKey="dollars"
            fill={CHART_COLOR}
            maxBarSize={24}
            radius={[4, 4, 0, 0]}
          >
            {data.map((point) => (
              <Cell
                fill={CHART_COLOR}
                fillOpacity={point.current ? 1 : EARLIER_WEEK_OPACITY}
                key={point.label}
              />
            ))}
            <LabelList
              className="fill-muted-foreground"
              dataKey="dollars"
              formatter={formatDollarValue}
              position="top"
            />
          </Bar>
          {capCents === null ? null : (
            <ReferenceLine
              ifOverflow="extendDomain"
              label={{
                className: "fill-muted-foreground",
                position: "insideTopRight",
                value: `Workspace limit ${capLabel(capCents)}`,
              }}
              stroke="var(--muted-foreground)"
              strokeDasharray="4 4"
              y={capCents / CENTS_PER_DOLLAR}
            />
          )}
        </BarChart>
      </ChartContainer>
    </div>
  );
}
