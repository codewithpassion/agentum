import {
  RAIL_REFRESH_EVENT,
  type RailItem,
  type RailView,
} from "@repo/db/shared";
import { Link, useRouterState } from "@tanstack/react-router";
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
import { Button } from "#/components/ui/button.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import { answerRequest } from "./answer.ts";
import { type CardActions, CardView } from "./card-view.tsx";
import { InlineList } from "./inline-list.tsx";
import {
  findCard,
  itemAfterAnswer,
  keepsSendError,
  missingItem,
  pruneAnswered,
  selectItem,
  selectionId,
  sendFailureText,
} from "./pane-logic.ts";
import { railScope } from "./scope-storage.ts";
import { SetupPane } from "./setup-pane.tsx";
import { type Elsewhere, useElsewhere } from "./use-elsewhere.ts";
import { useNowMs } from "./use-now-ms.ts";

/** A send that failed: the banner names the mail, and `under` is the item the answer moved to. */
interface SendError {
  cardId: string;
  text: string;
  under?: string | null;
}

/** The rail, the answerable requests behind its cards, and the skill versions proposed. */
const loadPane = async () => {
  const trpc = getTrpc();
  const scope = railScope.get();
  const [rail, pending, proposals] = await Promise.all([
    trpc.desk.rail.query({
      dayStart: localMidnightIso(new Date()),
      scope,
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
  return { rail, requests, scope, versions };
};

type Loaded = Awaited<ReturnType<typeof loadPane>>;

function MissingItem({
  elsewhere,
  onOpenWaiting,
  onShowEveryone,
}: {
  elsewhere: Elsewhere | null;
  onOpenWaiting: () => void;
  onShowEveryone: () => void;
}) {
  if (elsewhere === null) {
    return (
      <p className="text-muted-foreground text-sm">Looking for that item.</p>
    );
  }
  if (elsewhere === "everyone") {
    return (
      <div className="flex flex-col gap-3" data-testid="rail-missing">
        <p className="text-foreground">
          That item is under Everyone, not under Mine.
        </p>
        <div>
          <Button onClick={onShowEveryone} type="button" variant="outline">
            Show Everyone
          </Button>
        </div>
      </div>
    );
  }
  if (elsewhere === "gone") {
    return (
      <div className="flex flex-col gap-3" data-testid="rail-missing">
        <p className="text-foreground">That item is not waiting any more.</p>
        <div>
          <Button onClick={onOpenWaiting} type="button" variant="link">
            Open what is waiting
          </Button>
        </div>
      </div>
    );
  }
  return (
    <p className="text-destructive text-sm" role="alert">
      Could not look for that item.
    </p>
  );
}

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
  inline,
  item,
  onOpen,
}: {
  /** A phone with no item open: the list shows here, as the rail is closed. */
  inline: boolean;
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
  const [sendError, setSendError] = useState<SendError | null>(null);
  // Cards answered here. A poll that lands late cannot bring them back.
  const [answered, setAnswered] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  // The `item` in the URL says what is open. Two things fill the gaps. On a
  // bare /desk the first item is held once chosen, so a new item that sorts
  // first does not take the pane away from what is being read. After an
  // answer, `next` stands in until the URL catches up.
  const [held, setHeld] = useState<string | undefined>(undefined);
  const [next, setNext] = useState<string | undefined>(undefined);
  // The URL's `item` when an answer here moved the pane to another item. Until
  // the URL catches up, that item is gone because of us and is not "missing".
  const [settling, setSettling] = useState<string | undefined>(undefined);

  // A refresh, or the rail's scope toggle: the pane reads the shared scope on
  // every fetch, so it follows the toggle at once.
  useEffect(() => {
    window.addEventListener(RAIL_REFRESH_EVENT, refresh);
    const unsubscribe = railScope.subscribe(refresh);
    return () => {
      window.removeEventListener(RAIL_REFRESH_EVENT, refresh);
      unsubscribe();
    };
  }, [refresh]);

  useEffect(() => {
    if (item !== undefined) {
      setHeld(undefined);
    }
    setNext(undefined);
    setSettling(undefined);
  }, [item]);

  const list = useMemo(
    () => (data === null ? null : pruneAnswered(data.rail, answered)),
    [answered, data]
  );
  const selection = useMemo(
    () => (list === null ? null : selectItem(list, next ?? item ?? held)),
    [held, item, list, next]
  );
  const selectedId = selection === null ? null : selectionId(selection);
  const scope = data?.scope ?? null;
  // An item the URL names that is not listed. An answer here leaves the URL
  // behind for a moment, and that item is not missing.
  const missing = useMemo(
    () => missingItem(list, item, settling),
    [item, list, settling]
  );

  const elsewhere = useElsewhere(missing, scope);

  // A send error stays through the move its own answer makes, then goes once
  // another item is open.
  useEffect(() => {
    if (sendError !== null && !keepsSendError(sendError.under, selectedId)) {
      setSendError(null);
    }
  }, [selectedId, sendError]);

  useEffect(() => {
    if (item === undefined && next === undefined && selection !== null) {
      setHeld(selectionId(selection));
    }
  }, [item, next, selection]);

  // The shown item goes into the URL, so the rail marks it and a new item that
  // sorts first cannot move it. A phone keeps the list at a bare /desk.
  const navigating = useRouterState({
    select: (state) => state.status === "pending",
  });
  useEffect(() => {
    if (
      !(inline || navigating) &&
      item === undefined &&
      next === undefined &&
      selection !== null
    ) {
      onOpen(selectionId(selection));
    }
  }, [inline, item, navigating, next, onOpen, selection]);

  const latest = useRef({ item, list, selection });
  useEffect(() => {
    latest.current = { item, list, selection };
  });

  const answer = useCallback(
    async (requestId: string, payload: Parameters<typeof answerRequest>[2]) => {
      const { sendError: failed } = await answerRequest(
        (input) => getTrpc().requests.answer.mutate(input),
        requestId,
        payload
      );
      setSendError(
        failed === null
          ? null
          : {
              cardId: requestId,
              text: sendFailureText(
                findCard(latest.current.list, requestId)?.mail,
                failed
              ),
            }
      );
    },
    []
  );
  const showEveryone = useCallback(() => {
    railScope.set("everyone");
  }, []);
  const openWaiting = useCallback(() => onOpen(null), [onOpen]);
  const dismiss = useCallback(async (runId: string) => {
    await getTrpc().desk.clearAttention.mutate({ runId });
  }, []);

  // After any action: tell the rail, and open what comes next.
  const done = useCallback(
    (cardId: string): Promise<void> => {
      const { list: current, selection: open } = latest.current;
      if (current !== null && open?.kind === "item") {
        const following = itemAfterAnswer(current, open.item, cardId);
        setAnswered((previous) => new Set(previous).add(cardId));
        setSendError((previous) =>
          previous?.cardId === cardId
            ? { ...previous, under: following }
            : previous
        );
        // An answer that keeps the URL's item open has no gap to fill.
        if (following !== latest.current.item) {
          setNext(following ?? undefined);
          setSettling(latest.current.item);
        }
        onOpen(following);
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
          {sendError.text}
        </p>
      )}
      {missing === null ? null : (
        <MissingItem
          elsewhere={elsewhere}
          onOpenWaiting={openWaiting}
          onShowEveryone={showEveryone}
        />
      )}
      {missing === null && selection === null ? (
        <Empty rail={data.rail} />
      ) : null}
      {inline && list !== null && selection !== null ? (
        <InlineList
          items={list.needsYou}
          nowMs={nowMs}
          scope={data.scope}
          setup={list.setup}
        />
      ) : null}
      {!inline && missing === null && selection?.kind === "setup" ? (
        <SetupPane step={selection.step} />
      ) : null}
      {!inline && missing === null && selection?.kind === "item" ? (
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
