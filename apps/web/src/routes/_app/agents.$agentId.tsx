import { createFileRoute, redirect } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { useCallback } from "react";
import { z } from "zod";
import { ManageSheet } from "#/components/agent/profile/manage-sheet";
import { ProfileHeader } from "#/components/agent/profile/profile-header";
import { ProfileRows } from "#/components/agent/profile/profile-rows";
import { SHEET_IDS, type SheetId } from "#/components/agent/profile/sheet-ids";
import { getTrpc } from "#/integrations/trpc/client";

const searchSchema = z.object({
  sheet: z.enum(SHEET_IDS).optional().catch(undefined),
});

export const Route = createFileRoute("/_app/agents/$agentId")({
  validateSearch: (search) => searchSchema.parse(search),
  loader: async ({ params }) => {
    try {
      const [agent, profile] = await Promise.all([
        getTrpc().agents.get.query({ id: params.agentId }),
        getTrpc().agentProfile.profile.query({ agentId: params.agentId }),
      ]);
      return { agent, profile };
    } catch (error) {
      if (
        error instanceof TRPCClientError &&
        error.data?.code === "UNAUTHORIZED"
      ) {
        throw redirect({ to: "/login" });
      }
      throw error;
    }
  },
  component: AgentPage,
});

function AgentPage() {
  const { agent, profile } = Route.useLoaderData();
  const { sheet } = Route.useSearch();
  const navigate = Route.useNavigate();

  const openSheet = useCallback(
    (next: SheetId | undefined) =>
      navigate({ search: { sheet: next }, replace: true }),
    [navigate]
  );
  const edit = useCallback(() => openSheet("edit"), [openSheet]);
  const close = useCallback(() => openSheet(undefined), [openSheet]);
  const openTask = useCallback(
    (runId: string) => navigate({ params: { runId }, to: "/tasks/$runId" }),
    [navigate]
  );

  return (
    <section className="mx-auto flex max-w-6xl flex-col gap-4">
      <ProfileHeader
        header={profile.header}
        onEdit={edit}
        onStarted={openTask}
      />
      <div className="flex flex-wrap items-start gap-4">
        <ProfileRows agent={agent} onOpen={openSheet} profile={profile} />
        {/* The side cards (Runs on, Ask me before, Recent tasks) arrive in V3.11. */}
      </div>
      <ManageSheet agent={agent} onClose={close} sheet={sheet} />
    </section>
  );
}
