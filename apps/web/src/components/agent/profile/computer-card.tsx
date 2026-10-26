/** Placeholder for the agent's computer, which arrives with V6. */
export function ComputerCard() {
  return (
    <section
      aria-label="Computer"
      className="min-w-0 rounded-lg border border-border bg-card"
    >
      <h2 className="px-4 py-3 font-semibold text-sm">Computer</h2>
      <p className="px-4 pb-3 text-muted-foreground text-xs">
        A computer for this agent comes with V6.
      </p>
    </section>
  );
}
