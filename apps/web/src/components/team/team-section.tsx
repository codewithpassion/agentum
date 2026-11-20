import type { ReactNode } from "react";

/** A titled block of the team page. */
export function TeamSection({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description?: string;
  title: string;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="font-heading text-foreground text-lg">{title}</h2>
        {description === undefined ? null : (
          <p className="text-muted-foreground text-sm">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}
