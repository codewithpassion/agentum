import type { ReactNode } from "react";
import { useMemo } from "react";
import {
  DesktopScreen,
  type TakeoverControls,
} from "#/components/computer/desktop-screen.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import type { TakeoverRequest } from "./task-logic.ts";

/** A card with a heading, for a slot of the task view. */
export function SlotCard({
  id,
  title,
  testId,
  children,
}: {
  id?: string;
  title: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section
      className="flex flex-col gap-2.5 rounded-[10px] border bg-card p-3 text-card-foreground"
      data-testid={testId}
      id={id}
    >
      <h2 className="font-semibold text-[15px]">{title}</h2>
      {children}
    </section>
  );
}

/** The files slot of the task view. */
export function FilesSlot() {
  return (
    <SlotCard testId="slot-files" title="Files">
      <p className="text-muted-foreground text-sm">
        Files for this task show up here. Coming with the library sync (V4).
      </p>
    </SlotCard>
  );
}

/** The anchor of the computer slot: V6.8's Slack card links to `#computer`. */
export const COMPUTER_ANCHOR = "computer";

/** Take over, hand back and cancel for one open request, through the takeover router. */
const takeoverControls = ({
  reason,
  requestId,
}: TakeoverRequest): TakeoverControls => ({
  cancel: async () => {
    await getTrpc().takeover.cancel.mutate({ requestId });
  },
  handBack: async (note) => {
    await getTrpc().takeover.handBack.mutate({
      requestId,
      ...(note === "" ? {} : { note }),
    });
  },
  reason,
  take: async () => {
    await getTrpc().takeover.take.mutate({ requestId });
  },
});

/** The computer slot of the task view: the agent's live screen, when it has a computer. */
export function ComputerSlot({
  computerMachineId,
  agentName,
  takeover,
}: {
  agentName: string;
  computerMachineId: string | null;
  /** The run's pending takeover request, or null. */
  takeover: TakeoverRequest | null;
}) {
  const controls = useMemo(
    () => (takeover === null ? null : takeoverControls(takeover)),
    [takeover]
  );
  return (
    <SlotCard
      id={COMPUTER_ANCHOR}
      testId="slot-computer"
      title={`${agentName}'s computer`}
    >
      {computerMachineId === null ? (
        <p className="text-muted-foreground text-sm">
          This agent has no computer.
        </p>
      ) : (
        <DesktopScreen machineId={computerMachineId} takeover={controls} />
      )}
    </SlotCard>
  );
}
