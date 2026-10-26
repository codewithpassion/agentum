import { Button } from "#/components/ui/button.tsx";
import type { AgentProfileView } from "#/integrations/trpc/types";
import { runtimeOptions } from "./profile-logic.ts";

/** The "Runs on" side card: the three runtimes, the current one marked. Information only. */
export function RunsOnCard({
  header,
  onAdvanced,
}: {
  header: AgentProfileView["header"];
  onAdvanced: () => void;
}) {
  const options = runtimeOptions(header.runtime, header.machine);
  return (
    <section
      aria-label="Runs on"
      className="min-w-0 flex-[1_1_240px] rounded-lg border border-border bg-card p-4"
    >
      <h2 className="font-semibold text-foreground text-sm">Runs on</h2>
      <p className="mt-1 text-muted-foreground text-xs">
        Shown for information. The runtime cannot be changed here.
      </p>
      <ul className="mt-3 flex flex-col gap-2">
        {options.map((option) => (
          <li
            className={`rounded-md border p-3 ${
              option.current ? "border-primary bg-primary/5" : "border-border"
            }`}
            key={option.runtime}
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-semibold text-sm">{option.title}</span>
              {option.machineState === null ? null : (
                <span
                  className={`rounded-full px-2 py-0.5 font-semibold text-xs ${
                    option.machineState === "Online"
                      ? "bg-emerald-100 text-emerald-900"
                      : "bg-amber-100 text-amber-900"
                  }`}
                >
                  {option.machineState}
                </span>
              )}
              {option.current ? (
                <span className="rounded-full border border-primary px-2 py-0.5 text-primary text-xs">
                  Current
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-muted-foreground text-xs">{option.text}</p>
          </li>
        ))}
      </ul>
      <div className="mt-3">
        <Button onClick={onAdvanced} variant="outline">
          Advanced
        </Button>
      </div>
    </section>
  );
}
