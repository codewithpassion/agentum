import type { ReactNode } from "react";

/** One labelled row of an agent profile. */
export function Row({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <div className="grid grid-cols-1 items-start gap-1 border-border border-t border-dashed py-2.5 first:border-t-0 md:grid-cols-[110px_minmax(0,1fr)] md:gap-2.5">
      <span className="font-semibold text-muted-foreground text-xs uppercase tracking-wider">
        {label}
      </span>
      <div className="min-w-0 text-sm">{children}</div>
    </div>
  );
}
