import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { AskBeforeCard } from "#/components/agent/profile/ask-before-card";
import { ComputerCard } from "#/components/agent/profile/computer-card";
import { ConnectionsCard } from "#/components/agent/profile/connections-card";
import { ManageSheet } from "#/components/agent/profile/manage-sheet";
import { ProfileHeader } from "#/components/agent/profile/profile-header";
import { ProfileRows } from "#/components/agent/profile/profile-rows";
import { RecentTasksCard } from "#/components/agent/profile/recent-tasks-card";
import { RunsOnCard } from "#/components/agent/profile/runs-on-card";
import { SHEET_IDS, type SheetId } from "#/components/agent/profile/sheet-ids";
import { allowedMailAddresses } from "#/components/agent/profile/sheets/mail-logic";
import { MailSheet } from "#/components/agent/profile/sheets/mail-sheet";
import { getTrpc } from "#/integrations/trpc/client";

const RECENT_TASKS = 5;

const searchSchema = z.object({
  // "1" opens the mail list, any other value opens that mail thread. The router
  // parses ?mail=1 as a number, so turn it back into text before checking it.
  mail: z
    .preprocess(
      (value) => (value === undefined ? undefined : String(value)),
      z.string().min(1).max(200).optional()
    )
    .catch(undefined),
  sheet: z.enum(SHEET_IDS).optional().catch(undefined),
});

export const Route = createFileRoute("/_app/agents/$agentId")({
  validateSearch: (search) => searchSchema.parse(search),
  loader: async ({ params }) => {
    try {
      const trpc = getTrpc();
      const [
        agent,
        profile,
        askBefore,
        tasks,
        machines,
        mailbox,
        rules,
        members,
        connections,
        published,
      ] = await Promise.all([
        trpc.agents.get.query({ id: params.agentId }),
        trpc.agentProfile.profile.query({ agentId: params.agentId }),
        trpc.agentProfile.askBefore.query({ agentId: params.agentId }),
        trpc.tasks.list.query({
          agentId: params.agentId,
          limit: RECENT_TASKS,
        }),
        trpc.machines.list.query(),
        trpc.mailbox.get.query({ agentId: params.agentId }),
        trpc.requests.rules.list.query({ agentId: params.agentId }),
        trpc.members.list.query().catch(() => null),
        trpc.a2a.list.query({ agentId: params.agentId }).catch(() => []),
        trpc.a2a.published.query({ agentId: params.agentId }).catch(() => null),
      ]);
      return {
        agent,
        askBefore,
        connections,
        machines,
        members,
        mailbox,
        profile,
        published,
        rules,
        tasks,
      };
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
  const {
    agent,
    askBefore,
    connections,
    machines,
    members,
    mailbox,
    profile,
    published,
    rules,
    tasks,
  } = Route.useLoaderData();
  const nowMs = useNowMs();
  const { mail, sheet } = Route.useSearch();
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
  const openMail = useCallback(
    (next: string | undefined) =>
      navigate({ search: { mail: next }, replace: true }),
    [navigate]
  );
  const openMailList = useCallback(() => openMail("1"), [openMail]);
  // A thread can change what the header and rows show, so reload as the sheet closes.
  const closeMail = useCallback(async () => {
    await openMail(undefined);
    await router.invalidate();
  }, [openMail, router]);
  const openTask = useCallback(
    (runId: string) => navigate({ params: { runId }, to: "/tasks/$runId" }),
    [navigate]
  );

  return (
    <section className="mx-auto flex max-w-6xl flex-col gap-4">
      <ProfileHeader
        header={profile.header}
        mailbox={mailbox}
        onEdit={edit}
        onOpenMail={openMailList}
        onStarted={openTask}
      />
      <div className="flex flex-wrap items-start gap-4">
        <ProfileRows
          agent={agent}
          mailbox={mailbox}
          members={members}
          onOpen={openSheet}
          onOpenMail={openMailList}
          profile={profile}
        />
        <aside className="flex min-w-0 flex-[1_1_300px] flex-col gap-4">
          <RunsOnCard header={profile.header} onAdvanced={edit} />
          <AskBeforeCard
            actions={askBefore}
            agentId={agent.id}
            mailAllowed={allowedMailAddresses(rules)}
          />
          <RecentTasksCard agentId={agent.id} nowMs={nowMs} tasks={tasks} />
          <ConnectionsCard
            agentId={agent.id}
            connections={connections}
            published={published}
          />
          <ComputerCard
            agent={agent}
            header={profile.header}
            machines={machines}
          />
        </aside>
      </div>
      <ManageSheet agent={agent} onClose={close} sheet={sheet} />
      <MailSheet
        agent={agent}
        mail={mail}
        onChange={openMail}
        onClose={closeMail}
      />
    </section>
  );
}
