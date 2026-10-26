import type { ReactNode } from "react";

/** A card with a heading, for a slot of the task view that is not built yet. */
export function SlotCard({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section
      className="flex flex-col gap-2.5 rounded-[10px] border bg-card p-3 text-card-foreground"
      data-testid={testId}
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

/** The computer slot of the task view. */
export function ComputerSlot() {
  return (
    <SlotCard testId="slot-computer" title="Computer">
      <p className="text-muted-foreground text-sm">
        The agent&apos;s live computer shows up here. Coming with the computer
        (V6).
      </p>
    </SlotCard>
  );
}

/** The thread slot of the task view. */
export function ThreadSlot() {
  return (
    <SlotCard testId="slot-thread" title="Thread">
      <p className="text-muted-foreground text-sm">
        The conversation around this task shows up here. Coming next (V2.12).
      </p>
    </SlotCard>
  );
}
