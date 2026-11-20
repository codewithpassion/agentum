import type { ReactNode } from "react";

/** A titled block inside a tab. */
export function RoomSection({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <h2 className="font-heading text-foreground text-lg">{title}</h2>
      {children}
    </section>
  );
}

/** The column every tab body sits in. */
export function TabBody({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-8">{children}</div>;
}

export const ARCHIVED_NOTE =
  "This agent is archived. Restore it to change this.";

/**
 * A panel that changes the agent. An archived agent shows a note in its place,
 * because a disabled fieldset does not stop links, or menus that open in a
 * portal outside it.
 */
export function Manage({
  archived,
  children,
}: {
  archived: boolean;
  children: ReactNode;
}) {
  return archived ? <ArchivedNote /> : children;
}

export function ArchivedNote() {
  return <p className="text-muted-foreground text-sm">{ARCHIVED_NOTE}</p>;
}
