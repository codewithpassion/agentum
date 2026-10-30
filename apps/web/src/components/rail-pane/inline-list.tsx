import type { RailItem, RailScope, RailSetupStep } from "@repo/db/shared";
import { NeedsYouRow, SetupRow } from "#/components/rail/rail-needs-you.tsx";

const noop = () => undefined;

/** The Needs you list a phone shows on `/desk` with no item, where the rail is closed. It uses the rail's own rows. */
export function InlineList({
  items,
  nowMs,
  scope,
  setup,
}: {
  items: readonly RailItem[];
  nowMs: number;
  scope: RailScope;
  setup: readonly RailSetupStep[];
}) {
  const now = new Date(nowMs);
  return (
    <div className="flex flex-col gap-2" data-testid="inline-list">
      <h1 className="font-heading text-3xl text-foreground">Needs you</h1>
      {setup.map((step) => (
        <SetupRow key={step} onNavigate={noop} step={step} />
      ))}
      {items.map((item) => (
        <NeedsYouRow
          fresh={false}
          item={item}
          key={item.id}
          now={now}
          onNavigate={noop}
          open={false}
          scope={scope}
        />
      ))}
    </div>
  );
}
