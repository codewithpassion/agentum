import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { ArchivedAgentBanner } from "#/components/agent/archived-agents";
import { MailSheet } from "#/components/agent/profile/sheets/mail-sheet";
import { RoomFrame } from "#/components/agent/room/room-frame";
import {
  DEFAULT_TAB,
  ROOM_TABS,
  type RoomTab,
  resolveTab,
  SHEET_IDS,
} from "#/components/agent/room/tabs";
import { getTrpc } from "#/integrations/trpc/client";
import { loadOrLogin } from "#/integrations/trpc/load-or-login";

const RECENT_TASKS = 5;
const RECENT_THREADS = 8;

const searchSchema = z.object({
  // "1" opens the mail list, any other value opens that mail thread. The router
  // parses ?mail=1 as a number, so turn it back into text before checking it.
  mail: z
    .preprocess(
      (value) => (value === undefined ? undefined : String(value)),
      z.string().min(1).max(200).optional()
    )
    .catch(undefined),
  // Old links: each sheet is now a section of a tab, see resolveTab.
  sheet: z.enum(SHEET_IDS).optional().catch(undefined),
  tab: z.enum(ROOM_TABS).optional().catch(undefined),
});

export const Route = createFileRoute("/_app/agents/$agentId")({
  validateSearch: (search) => searchSchema.parse(search),
  loader: async ({ params }) =>
    loadOrLogin(async () => {
      const trpc = getTrpc();
      const [
        agent,
        profile,
        askBefore,
        askLevel,
        tasks,
        threads,
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
        trpc.agentProfile.askLevel.query({ agentId: params.agentId }),
        trpc.tasks.list.query({
          agentId: params.agentId,
          limit: RECENT_TASKS,
        }),
        trpc.sessions.list.query({
          agentId: params.agentId,
          limit: RECENT_THREADS,
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
        askLevel,
        connections,
        machines,
        members,
        mailbox,
        profile,
        published,
        rules,
        tasks,
        threads,
      };
    }),
  component: AgentPage,
});

/** The current time, set after mount so server and browser markup match. */
function useNowMs(): number | null {
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => setNowMs(Date.now()), []);
  return nowMs;
}

function AgentPage() {
  const room = Route.useLoaderData();
  const { agent } = room;
  const archived = agent.status === "archived";
  const nowMs = useNowMs();
  const search = Route.useSearch();
  const tab = resolveTab(search);
  const navigate = Route.useNavigate();
  const router = useRouter();

  // The tab is explicit while the mailbox sheet is open, so closing it keeps the tab.
  const searchTab = tab === DEFAULT_TAB ? undefined : tab;
  const openTab = useCallback(
    (next: RoomTab) =>
      navigate({
        search: { tab: next === DEFAULT_TAB ? undefined : next },
        replace: true,
      }),
    [navigate]
  );
  const edit = useCallback(() => openTab("settings"), [openTab]);
  const openMail = useCallback(
    (next: string | undefined) =>
      navigate({
        search: { mail: next, tab: next === undefined ? searchTab : tab },
        replace: true,
      }),
    [navigate, searchTab, tab]
  );
  const openMailList = useCallback(() => openMail("1"), [openMail]);
  // A thread can change what the header shows, so reload as the sheet closes.
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
      {archived ? <ArchivedAgentBanner agent={agent} /> : null}
      <RoomFrame
        nowMs={nowMs}
        onEdit={edit}
        onOpenMail={openMailList}
        onOpenTab={openTab}
        onStarted={openTask}
        room={room}
        tab={tab}
      />
      {archived ? null : (
        <MailSheet
          agent={agent}
          mail={search.mail}
          onChange={openMail}
          onClose={closeMail}
        />
      )}
    </section>
  );
}
