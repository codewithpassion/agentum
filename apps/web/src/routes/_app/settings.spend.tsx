import { useAuth } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback } from "react";
import { CapField } from "#/components/spend/cap-field.tsx";
import { capLabel } from "#/components/spend/spend-logic.ts";
import { getTrpc } from "#/integrations/trpc/client";
import { loadOrLogin } from "#/integrations/trpc/load-or-login";

export const PAGE_HEADING = "Spend limit";

export const Route = createFileRoute("/_app/settings/spend")({
  loader: async () =>
    loadOrLogin(
      async () => (await getTrpc().spend.caps.query()).workspaceCapCents
    ),
  component: SpendPage,
});

function SpendPage() {
  const savedCents = Route.useLoaderData();
  const { orgRole } = useAuth();
  const isAdmin = orgRole === "org:admin";

  const save = useCallback(async (cents: number | null) => {
    await getTrpc().spend.setCap.mutate({
      agentId: null,
      weeklyCapCents: cents,
    });
  }, []);

  return (
    <section className="mx-auto max-w-3xl">
      <h1 className="mb-6 font-heading text-3xl text-foreground">
        {PAGE_HEADING}
      </h1>
      {isAdmin ? (
        <CapField
          help="When every agent's spend this week adds up to this amount, all agents stop until the new week starts or an owner resumes them. Leave empty for no limit."
          id="workspace-cap"
          label="Weekly limit for the whole workspace"
          onSave={save}
          savedCents={savedCents}
        />
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-foreground text-sm">
            {savedCents === null
              ? "No workspace limit."
              : `Workspace limit: ${capLabel(savedCents)} a week`}
          </p>
          <p className="text-muted-foreground text-sm">An admin sets this.</p>
        </div>
      )}
    </section>
  );
}
