import { Link, useRouter } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { getTrpc } from "#/integrations/trpc/client";
import type {
  AgentProfileView,
  AgentRecord,
  MachineRecord,
} from "#/integrations/trpc/types";
import { errorMessage } from "#/lib/error-message";
import { ComputerChoiceRow } from "./computer-choice-row.tsx";
import { computerChoices, machineAgentWords } from "./profile-logic.ts";

/** The "Computer" side card: the machine the agent runs on, or the computers it can attach to. */
export function ComputerCard({
  agent,
  header,
  machines,
}: {
  agent: AgentRecord;
  header: AgentProfileView["header"];
  machines: MachineRecord[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();

  const choose = useCallback(
    async (machineId: string | null) => {
      setPending(true);
      setFailure(undefined);
      try {
        await getTrpc().machines.attachComputer.mutate({
          agentId: agent.id,
          machineId,
        });
        await router.invalidate();
      } catch (error) {
        setFailure(errorMessage(error));
      } finally {
        setPending(false);
      }
    },
    [agent.id, router]
  );

  const choices = computerChoices(agent.computerMachineId, machines);

  return (
    <section
      aria-label="Computer"
      className="min-w-0 rounded-lg border border-border bg-card p-4"
    >
      <h2 className="font-semibold text-foreground text-sm">Computer</h2>
      {agent.runtime === "machine" ? (
        <>
          <p className="mt-1 text-sm">{machineAgentWords(header.machine)}</p>
          <p className="mt-1 text-muted-foreground text-xs">
            It works on that machine's own files, so it does not need a separate
            computer.
          </p>
        </>
      ) : (
        <>
          <p className="mt-1 text-muted-foreground text-xs">
            A computer gives the agent a browser and, on a desktop computer, a
            screen.
          </p>
          {choices.length === 0 ? (
            <p className="mt-3 text-sm">
              No computer yet.{" "}
              <Link className="text-primary underline" to="/settings/machines">
                Add a computer
              </Link>
            </p>
          ) : (
            <ul className="mt-3 flex flex-col gap-2">
              {choices.map((choice) => (
                <ComputerChoiceRow
                  choice={choice}
                  disabled={pending}
                  key={choice.id}
                  onChoose={choose}
                />
              ))}
            </ul>
          )}
        </>
      )}
      {failure === undefined ? null : (
        <p className="mt-2 text-destructive text-xs" role="alert">
          {failure}
        </p>
      )}
    </section>
  );
}
