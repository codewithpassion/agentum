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
