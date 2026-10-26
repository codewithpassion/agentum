import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { AskBeforeCard } from "#/components/agent/profile/ask-before-card";
import { ComputerCard } from "#/components/agent/profile/computer-card";
import { ManageSheet } from "#/components/agent/profile/manage-sheet";
import { ProfileHeader } from "#/components/agent/profile/profile-header";
import { ProfileRows } from "#/components/agent/profile/profile-rows";
import { RecentTasksCard } from "#/components/agent/profile/recent-tasks-card";
import { RunsOnCard } from "#/components/agent/profile/runs-on-card";
import { SHEET_IDS, type SheetId } from "#/components/agent/profile/sheet-ids";
import { getTrpc } from "#/integrations/trpc/client";

const RECENT_TASKS = 5;

const searchSchema = z.object({
  sheet: z.enum(SHEET_IDS).optional().catch(undefined),
});

export const Route = createFileRoute("/_app/agents/$agentId")({
  validateSearch: (search) => searchSchema.parse(search),
  loader: async ({ params }) => {
    try {
      const trpc = getTrpc();
      const [agent, profile, askBefore, tasks] = await Promise.all([
        trpc.agents.get.query({ id: params.agentId }),
        trpc.agentProfile.profile.query({ agentId: params.agentId }),
        trpc.agentProfile.askBefore.query({ agentId: params.agentId }),
        trpc.tasks.list.query({ agentId: params.agentId, limit: RECENT_TASKS }),
      ]);
      return { agent, askBefore, profile, tasks };
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

/** The current time, set after mount so server and browser markup match. */
function useNowMs(): number | null {
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => setNowMs(Date.now()), []);
  return nowMs;
}

function AgentPage() {
  const { agent, askBefore, profile, tasks } = Route.useLoaderData();
  const nowMs = useNowMs();
  const { sheet } = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();

  const openSheet = useCallback(
    (next: SheetId | undefined) =>
      navigate({ search: { sheet: next }, replace: true }),
    [navigate]
  );
  const edit = useCallback(() => openSheet("edit"), [openSheet]);
  // The panels change what the rows show, so reload the profile as the sheet closes.
  const close = useCallback(async () => {
    await openSheet(undefined);
    await router.invalidate();
  }, [openSheet, router]);
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
        <aside className="flex min-w-0 flex-[1_1_300px] flex-col gap-4">
          <RunsOnCard header={profile.header} onAdvanced={edit} />
          <AskBeforeCard actions={askBefore} agentId={agent.id} />
          <RecentTasksCard agentId={agent.id} nowMs={nowMs} tasks={tasks} />
          <ComputerCard />
        </aside>
      </div>
      <ManageSheet agent={agent} onClose={close} sheet={sheet} />
    </section>
  );
}
