import {
  RAIL_REFRESH_EVENT,
  type RailItem,
  type RailScope,
  type RailView,
} from "@repo/db/shared";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { localMidnightIso } from "#/components/desk/desk-logic.ts";
import {
  DESK_POLL_INTERVAL_MS,
  usePolledQuery,
} from "#/components/inbox/use-polled-query.ts";
import {
  type RequestView,
  viewFromRecord,
} from "#/components/requests/request-card-logic.ts";
import { getTrpc } from "#/integrations/trpc/client";
import { answerRequest } from "./answer.ts";
import { type CardActions, CardView } from "./card-view.tsx";
import {
  itemAfterAnswer,
  pruneAnswered,
  selectItem,
  selectionId,
} from "./pane-logic.ts";
import { SetupPane } from "./setup-pane.tsx";
import { useNowMs } from "./use-now-ms.ts";

/** Where the rail keeps the viewer's choice between Mine and Everyone. */
const SCOPE_KEY = "hm:rail-scope";

const readScope = (): RailScope =>
  window.localStorage.getItem(SCOPE_KEY) === "everyone" ? "everyone" : "mine";

/** The rail, the answerable requests behind its cards, and the skill versions proposed. */
const loadPane = async () => {
  const trpc = getTrpc();
  const [rail, pending, proposals] = await Promise.all([
    trpc.desk.rail.query({
      dayStart: localMidnightIso(new Date()),
      scope: readScope(),
    }),
    trpc.requests.pending.query({}),
    trpc.skillStore.proposals.query(),
  ]);
  const requests = new Map<string, RequestView>();
  for (const record of pending) {
    const view = viewFromRecord(record, null);
    if (view !== null) {
      requests.set(view.id, view);
    }
  }
  const versions = new Map(
    proposals.map((version) => [
      version.id,
      { number: version.number, skillId: version.skillId },
    ])
  );
  return { rail, requests, versions };
};

type Loaded = Awaited<ReturnType<typeof loadPane>>;

function Empty({ rail }: { rail: RailView }) {
  const inHand = rail.working.length;
  return (
    <div className="flex flex-col gap-2" data-testid="rail-empty">
      <h1 className="font-heading text-3xl text-foreground">
        Nothing needs you
      </h1>
      <p className="text-muted-foreground">
        {inHand === 0
          ? "Anything new will show up on the left."
          : `${inHand} ${inHand === 1 ? "thing is" : "things are"} in hand. Anything new will show up on the left.`}
      </p>
      <p>
        <Link
          className="text-muted-foreground text-sm underline underline-offset-2"
          search={{ view: "board" }}
          to="/desk"
        >
          Open the board
        </Link>
      </p>
    </div>
  );
}

function ItemCards({
  actions,
  item,
  loaded,
  nowMs,
}: {
  actions: CardActions;
  item: RailItem;
  loaded: Loaded;
  nowMs: number;
}) {
  return (
    <div>
      {item.cards.map((card, index) => (
        <CardView
          actions={actions}
          card={card}
          first={index === 0}
          key={card.id}
          nowMs={nowMs}
          request={loaded.requests.get(card.id) ?? null}
          version={loaded.versions.get(card.id) ?? null}
          waitingOn={item.assigneeName}
        />
      ))}
    </div>
  );
}

/** The main pane: the open item, decided in plain words. */
export function RailPane({
  item,
  onOpen,
}: {
  /** The `item` search param. */
  item: string | undefined;
  /** Opens an item by id, or the default one for null. */
  onOpen: (id: string | null) => void;
}) {
  const nowMs = useNowMs();
  const { data, error, refresh } = usePolledQuery(
    loadPane,
    null,
    DESK_POLL_INTERVAL_MS
  );
  const [sendError, setSendError] = useState<string | null>(null);
  // Cards answered here. A poll that lands late cannot bring them back.
  const [answered, setAnswered] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  // The open item holds still: a new item that sorts first on a bare /desk
  // does not take the pane away from what is being read.
  const [shown, setShown] = useState(item);

  useEffect(() => {
    window.addEventListener(RAIL_REFRESH_EVENT, refresh);
    return () => window.removeEventListener(RAIL_REFRESH_EVENT, refresh);
  }, [refresh]);

  useEffect(() => {
    if (item !== undefined) {
      setShown(item);
    }
  }, [item]);

  const list = useMemo(
    () => (data === null ? null : pruneAnswered(data.rail, answered)),
    [answered, data]
  );
  const selection = useMemo(
    () => (list === null ? null : selectItem(list, shown)),
    [list, shown]
  );

  useEffect(() => {
    if (selection !== null) {
      setShown(selectionId(selection));
    }
  }, [selection]);

  const latest = useRef({ list, selection });
  useEffect(() => {
    latest.current = { list, selection };
  });

  const answer = useCallback(
    async (requestId: string, payload: Parameters<typeof answerRequest>[2]) => {
      const { sendError: failed } = await answerRequest(
        (input) => getTrpc().requests.answer.mutate(input),
        requestId,
        payload
      );
      setSendError(failed);
    },
    []
  );
  const dismiss = useCallback(async (runId: string) => {
    await getTrpc().desk.clearAttention.mutate({ runId });
  }, []);

  // After any action: tell the rail, and open what comes next.
  const done = useCallback(
    (cardId: string): Promise<void> => {
      const { list: current, selection: open } = latest.current;
      if (current !== null && open?.kind === "item") {
        const next = itemAfterAnswer(current, open.item, cardId);
        setAnswered((previous) => new Set(previous).add(cardId));
        if (next !== null) {
          setShown(next);
        }
        onOpen(next);
      }
      window.dispatchEvent(new Event(RAIL_REFRESH_EVENT));
      return Promise.resolve();
    },
    [onOpen]
  );
  const actions = useMemo(
    () => ({ onAnswer: answer, onDismiss: dismiss, onDone: done }),
    [answer, dismiss, done]
  );

  if (data === null || nowMs === null) {
    return (
      <p className="text-muted-foreground text-sm">{error ?? "Loading…"}</p>
    );
  }
  return (
    <section className="mx-auto flex w-full max-w-[720px] flex-col gap-4 pt-2 pb-16">
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
      {selection === null ? <Empty rail={data.rail} /> : null}
      {selection?.kind === "setup" ? <SetupPane step={selection.step} /> : null}
      {selection?.kind === "item" ? (
        <ItemCards
          actions={actions}
          item={selection.item}
          loaded={data}
          nowMs={nowMs}
        />
      ) : null}
    </section>
  );
}
