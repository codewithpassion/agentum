import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { PinnedDeskTiles } from "#/components/artifacts/pinned/pinned-tiles";
import { AgentFilter } from "#/components/desk/agent-filter";
import { DeskBoard, type ProposedVersion } from "#/components/desk/desk-board";
import { localMidnightIso } from "#/components/desk/desk-logic";
import { MailStrip } from "#/components/desk/mail-strip";
import { NewTaskDialog } from "#/components/desk/new-task-dialog";
import {
  DESK_POLL_INTERVAL_MS,
  usePolledQuery,
} from "#/components/inbox/use-polled-query";
import { RailPane } from "#/components/rail-pane/rail-pane";
import { useNowMs } from "#/components/rail-pane/use-now-ms";
import {
  type AnswerPayload,
  isConflict,
  type RequestView,
  viewFromRecord,
} from "#/components/requests/request-card-logic";
import { buttonVariants } from "#/components/ui/button";
import { getTrpc } from "#/integrations/trpc/client";

const searchSchema = z.object({
  agent: z.string().min(1).optional().catch(undefined),
  item: z.string().min(1).max(300).optional().catch(undefined),
  view: z.literal("board").optional().catch(undefined),
});

export const Route = createFileRoute("/_app/desk")({
  validateSearch: (search) => searchSchema.parse(search),
  // The agents for the chips and the names on cards. The desk itself loads in
  // the browser, because "today" starts at the viewer's local midnight.
  loader: async () => {
    try {
      return await getTrpc().agents.list.query({});
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
  component: Desk,
});

/** The desk, the answerable requests behind its cards, and the skill versions proposed. */
const loadDesk = async (agentId: string | undefined) => {
  const trpc = getTrpc();
  const [desk, pending, proposals, mail, pins] = await Promise.all([
    trpc.desk.get.query({
      dayStart: localMidnightIso(new Date()),
      ...(agentId === undefined ? {} : { agentId }),
    }),
    trpc.requests.pending.query({}),
    trpc.skillStore.proposals.query(),
    trpc.mailToday.query(),
    // Pinned tiles are a nicety: the desk still loads without them.
    trpc.artifacts.pins.query({ surface: "desk" }).catch(() => []),
  ]);
  const requests = new Map<string, RequestView>();
  for (const record of pending) {
    const view = viewFromRecord(record, null);
    if (view !== null) {
      requests.set(view.id, view);
    }
  }
  const versions = new Map<string, ProposedVersion>(
    proposals.map((version) => [
      version.id,
      { number: version.number, skillId: version.skillId },
    ])
  );
  return { desk, mail, pins, requests, versions };
};

const dateText = (nowMs: number): string =>
  new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "long",
    weekday: "long",
  }).format(nowMs);

/** Today's desk, three lanes. It lives at `/desk?view=board`. */
function BoardView() {
  const agents = Route.useLoaderData();
  const { agent } = Route.useSearch();
  const navigate = Route.useNavigate();
  const nowMs = useNowMs();
  const agentNames = useMemo(
    () => new Map(agents.map((entry) => [entry.id, entry.name])),
    [agents]
  );

  const { data, error, refresh } = usePolledQuery(
    () => loadDesk(agent),
    null,
    DESK_POLL_INTERVAL_MS
  );

  // A new filter loads at once. The first load belongs to the hook itself.
  const shownAgent = useRef(agent);
  useEffect(() => {
    if (shownAgent.current !== agent) {
      shownAgent.current = agent;
      refresh();
    }
  }, [agent, refresh]);

  const selectAgent = useCallback(
    (id: string | null) =>
      navigate({
        search: id === null ? { view: "board" } : { agent: id, view: "board" },
      }),
    [navigate]
  );

  const openTask = useCallback(
    (runId: string) => navigate({ params: { runId }, to: "/tasks/$runId" }),
    [navigate]
  );

  // An answered approval leaves the desk at once, so a mail that was allowed
  // and then failed to send is told here.
  const [sendError, setSendError] = useState<string | null>(null);
  const answer = useCallback(
    async (view: RequestView, payload: AnswerPayload) => {
      try {
        const record = await getTrpc().requests.answer.mutate({
          ...payload,
          requestId: view.id,
        });
        setSendError(record.sendError);
      } catch (cause) {
        if (!isConflict(cause)) {
          throw cause;
        }
      }
      await refresh();
    },
    [refresh]
  );

  return (
    <section className="mx-auto flex max-w-6xl flex-col gap-5">
      <header className="flex flex-wrap items-center gap-3">
        <div className="min-w-60 flex-1">
          <h1 className="font-heading text-3xl text-foreground">Desk</h1>
          <p className="text-muted-foreground text-sm">
            {nowMs === null ? "" : `${dateText(nowMs)} · `}
            {agents.length} {agents.length === 1 ? "agent" : "agents"}
          </p>
        </div>
        <AgentFilter
          agents={agents}
          onSelect={selectAgent}
          selected={agent ?? null}
        />
        <NewTaskDialog agents={agents} onStarted={openTask} />
        <Link className={buttonVariants()} to="/agents/new">
          + New agent
        </Link>
      </header>
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      {sendError === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          Allowed, but the mail could not be sent: {sendError}
        </p>
      )}
      {data === null ? null : <PinnedDeskTiles pins={data.pins} />}
      {data === null ? null : <MailStrip agent={agent} rows={data.mail} />}
      {data === null || nowMs === null ? (
        <p className="text-muted-foreground text-sm">Loading the desk…</p>
      ) : (
        <DeskBoard
          agentNames={agentNames}
          desk={data.desk}
          nowMs={nowMs}
          onAnswer={answer}
          onChanged={refresh}
          requests={data.requests}
          versions={data.versions}
        />
      )}
    </section>
  );
}

/** The open rail item, or the board with `?view=board`. */
function Desk() {
  const { item, view } = Route.useSearch();
  const navigate = Route.useNavigate();
  const open = useCallback(
    (id: string | null) =>
      navigate({
        replace: true,
        search: id === null ? {} : { item: id },
      }),
    [navigate]
  );
  return view === "board" ? (
    <BoardView />
  ) : (
    <RailPane item={item} onOpen={open} />
  );
}
