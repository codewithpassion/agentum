import { useRouter } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { getTrpc } from "#/integrations/trpc/client";
import { NewTeamDialog } from "./new-team-dialog.tsx";
import {
  createTeamWithMembers,
  type NewTeamInput,
  type TeamAgent,
  type TeamPerson,
} from "./team-logic.ts";

/** The New team button and its dialog. Creating the team opens its page. */
export function NewTeamButton({
  agents,
  people,
  youId,
}: {
  agents: readonly TeamAgent[];
  people: readonly TeamPerson[] | null;
  youId: string | null | undefined;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const openDialog = useCallback(() => setOpen(true), []);
  const create = useCallback(
    async (input: NewTeamInput) => {
      const trpc = getTrpc();
      const { failed, team } = await createTeamWithMembers(
        {
          addMember: (member) => trpc.teams.addMember.mutate(member),
          create: (fields) => trpc.teams.create.mutate(fields),
        },
        input
      );
      if (failed.length > 0) {
        toast.warning(
          `${team.name} was created, but ${failed.length} could not be added. Add them on the team page.`
        );
      }
      setOpen(false);
      // Find lists the teams, so the layout's data is read again too.
      await router.invalidate();
      await router.navigate({
        params: { teamId: team.id },
        to: "/teams/$teamId",
      });
    },
    [router]
  );
  return (
    <>
      <Button onClick={openDialog} type="button">
        New team
      </Button>
      <NewTeamDialog
        agents={agents}
        onCreate={create}
        onOpenChange={setOpen}
        open={open}
        people={people}
        youId={youId}
      />
    </>
  );
}
