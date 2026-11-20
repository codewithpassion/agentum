import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { ArchivedAgentBanner } from "#/components/agent/archived-agents";
import { MailSheet } from "#/components/agent/profile/sheets/mail-sheet";
import type { RoomSpend } from "#/components/agent/room/room-data";
import { RoomFrame } from "#/components/agent/room/room-frame";
import {
  DEFAULT_TAB,
  legacyRedirectSearch,
  MAIL_LIST,
  mailParam,
  ROOM_TABS,
  type RoomTab,
  resolveTab,
  SHEET_IDS,
} from "#/components/agent/room/tabs";
import { spendWeeks } from "#/components/spend/spend-logic";
import { getTrpc } from "#/integrations/trpc/client";
import { loadOrLogin } from "#/integrations/trpc/load-or-login";

/** This week's spend and the weekly limit of one agent. A failed read leaves the spend out. */
const loadRoomSpend = async (agentId: string): Promise<RoomSpend> => {
  const trpc = getTrpc();
  try {
    const [{ timezone }, caps] = await Promise.all([
      trpc.workspaces.timezone.query(),
      trpc.spend.caps.query(),
    ]);
    const thisWeek = spendWeeks(new Date(), timezone).at(-1);
    const cap = caps.agents.find((entry) => entry.agentId === agentId);
    const rows = thisWeek
      ? await trpc.spend.byAgent.query({
          agentId,
          from: thisWeek.start,
          to: thisWeek.end,
        })
      : [];
    return {
      capCents: cap?.weeklyCapCents ?? null,
      paused: (cap?.pausedAt ?? null) !== null,
      weekCents: rows.reduce((total, row) => total + row.cents, 0),
    };
  } catch {
    return { capCents: null, paused: false, weekCents: null };
  }
};

const RECENT_TASKS = 5;
const RECENT_THREADS = 8;

const searchSchema = z.object({
  // 1 opens the mail list, any other value opens that mail thread. The router
  // parses ?mail=1 as a number, so the page turns it back into text.
  mail: z
    .union([z.string().min(1).max(200), z.number()])
    .optional()
    .catch(undefined),
  // Old links: each sheet is now a section of a tab, see resolveTab.
  sheet: z.enum(SHEET_IDS).optional().catch(undefined),
  tab: z.enum(ROOM_TABS).optional().catch(undefined),
});

export const Route = createFileRoute("/_app/agents/$agentId")({
  validateSearch: (search) => searchSchema.parse(search),
  // An old ?sheet= or ?mail= link lands on the tab that holds it, with ?tab= in the address bar.
  beforeLoad: ({ params, search }) => {
    const next = legacyRedirectSearch(search);
    if (next !== null) {
      throw redirect({
        params,
        replace: true,
        search: next,
        to: "/agents/$agentId",
      });
    }
  },
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
        keys,
        spend,
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
        trpc.keys.forAgent.query({ agentId: params.agentId }).catch(() => null),
        loadRoomSpend(params.agentId),
      ]);
      return {
        agent,
        askBefore,
        askLevel,
        connections,
        keys,
        machines,
        members,
        mailbox,
        profile,
        published,
        rules,
        spend,
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
  const mail = search.mail === undefined ? undefined : String(search.mail);
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
        search: {
          mail: mailParam(next),
          tab: next === undefined ? searchTab : tab,
        },
        replace: true,
      }),
    [navigate, searchTab, tab]
  );
  const openMailList = useCallback(() => openMail(MAIL_LIST), [openMail]);
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
          mail={mail}
          onChange={openMail}
          onClose={closeMail}
        />
      )}
    </section>
  );
}
