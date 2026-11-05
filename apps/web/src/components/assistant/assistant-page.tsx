import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Plus, Sparkles } from "lucide-react";
import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { SendHint } from "#/components/composer/send-hint";
import { submitOnSendShortcut } from "#/components/composer/send-shortcut";
import { StickyComposer } from "#/components/composer/sticky-composer";
import { errorMessage } from "#/components/secrets/secret-model";
import { Button } from "#/components/ui/button";
import { Label } from "#/components/ui/label";
import { Spinner } from "#/components/ui/spinner";
import { Textarea } from "#/components/ui/textarea";
import { getTrpc } from "#/integrations/trpc/client";
import type { RouterOutputs } from "#/integrations/trpc/types";
import { AssistantCard } from "./cards";
import { AssistantMessages } from "./messages";
import type {
  AssistantAgent,
  CardOutcome,
  Conversation,
  PendingCard,
} from "./types";

const manualCard: PendingCard = {
  arguments: {
    mode: "env",
    name: "",
    reason: "Store a secret securely in this workspace.",
  },
  kind: "secret",
  title: "Add secret",
  tool: "request_secret",
  toolUseId: "manual",
};

export function AssistantPage({
  initial,
  initialList,
  agents,
  hasKey,
  admin,
}: {
  admin: boolean;
  agents: AssistantAgent[];
  hasKey: boolean;
  initial: Conversation | null;
  initialList: RouterOutputs["assistant"]["list"];
}) {
  const navigate = useNavigate();
  const [conversation, setConversation] = useState(initial);
  const [list, setList] = useState(initialList);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [manualVersion, setManualVersion] = useState(0);
  const [showList, setShowList] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (conversation || busy || manual) {
      bottom.current?.scrollIntoView({ block: "end" });
    }
  }, [conversation, busy, manual]);

  const accept = useCallback(
    async (next: Conversation) => {
      setConversation(next);
      setList(await getTrpc().assistant.list.query());
      if (!conversation) {
        await navigate({
          replace: true,
          search: { c: next.id },
          to: "/assistant",
        });
      }
    },
    [conversation, navigate]
  );
  const resolve = useCallback(
    async (outcome: CardOutcome) => {
      if (!conversation?.pendingCard) {
        return;
      }
      setBusy(true);
      setError(null);
      try {
        await accept(
          await getTrpc().assistant.resolveCard.mutate({
            conversationId: conversation.id,
            outcome,
            toolUseId: conversation.pendingCard.toolUseId,
          })
        );
      } finally {
        setBusy(false);
      }
    },
    [conversation, accept]
  );
  const send = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (busy || !text.trim()) {
        return;
      }
      setBusy(true);
      setShowList(false);
      setManual(false);
      setError(null);
      try {
        await accept(
          await getTrpc().assistant.send.mutate({
            conversationId: conversation?.id,
            text: text.trim(),
          })
        );
        setText("");
      } catch (caught) {
        const message = errorMessage(caught);
        setError(message);
        if (message.includes("That looks like a key")) {
          setText("");
        }
        if (conversation) {
          setConversation(
            await getTrpc().assistant.get.query({
              conversationId: conversation.id,
            })
          );
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, text, conversation, accept]
  );
  const archive = useCallback(async () => {
    if (!conversation || busy) {
      return;
    }
    setBusy(true);
    try {
      await getTrpc().assistant.archive.mutate({
        conversationId: conversation.id,
      });
      await navigate({ search: {}, to: "/assistant" });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }, [conversation, busy, navigate]);
  const openManual = useCallback(() => {
    setManual(true);
    setManualVersion((version) => version + 1);
    setShowList(false);
    setError(null);
  }, []);

  const newConversation = useCallback(async () => {
    await navigate({ search: {}, to: "/assistant" });
    setConversation(null);
    setText("");
    setManual(false);
    setShowList(false);
  }, [navigate]);
  const back = useCallback(() => setShowList(true), []);
  const resolveManual = useCallback(() => Promise.resolve(), []);
  const changeText = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => setText(event.target.value),
    []
  );
  const selectConversation = useCallback(
    (event: import("react").MouseEvent<HTMLButtonElement>) => {
      const c = event.currentTarget.dataset.conversationId;
      setShowList(false);
      return navigate({ search: { c }, to: "/assistant" });
    },
    [navigate]
  );

  return (
    <section aria-label="Workspace assistant" className="flex min-h-0 flex-1">
      <aside
        className={`${showList ? "flex" : "hidden"} w-full shrink-0 flex-col border-r md:flex md:w-60`}
      >
        <div className="flex items-center justify-between border-b p-4">
          <h1 className="font-heading text-lg">Assistant</h1>
          <Button
            aria-label="New conversation"
            disabled={busy}
            onClick={newConversation}
            size="icon"
            variant="ghost"
          >
            <Plus className="size-4" />
          </Button>
        </div>
        <nav
          aria-label="Conversations"
          className="flex-1 space-y-1 overflow-y-auto p-2"
        >
          {list.length ? (
            list.map((item) => (
              <button
                className={`block w-full rounded-md px-3 py-3 text-left text-sm hover:bg-muted ${conversation?.id === item.id ? "bg-muted font-medium" : "text-muted-foreground"}`}
                data-conversation-id={item.id}
                disabled={busy}
                key={item.id}
                onClick={selectConversation}
                type="button"
              >
                {item.title}
              </button>
            ))
          ) : (
            <p className="px-3 py-4 text-muted-foreground text-sm">
              Your conversations will appear here. Only you can see them.
            </p>
          )}
        </nav>
        <p className="border-t p-4 text-muted-foreground text-xs">
          Private to you in this workspace.
        </p>
      </aside>
      <div
        className={`${showList ? "hidden" : "flex"} min-w-0 flex-1 flex-col md:flex`}
      >
        <header className="flex min-h-16 items-center justify-between gap-2 border-b px-4">
          <div className="flex min-w-0 items-center gap-2">
            <Button
              aria-label="Back to conversations"
              className="md:hidden"
              disabled={busy}
              onClick={back}
              size="icon"
              variant="ghost"
            >
              <ArrowLeft className="size-4" />
            </Button>
            <h2 className="truncate font-medium text-sm">
              {conversation?.title ?? "New conversation"}
            </h2>
          </div>
          <div className="flex shrink-0 gap-1">
            {admin ? (
              <Button
                disabled={busy}
                onClick={openManual}
                size="sm"
                variant="ghost"
              >
                Add secret
              </Button>
            ) : null}
            {conversation ? (
              <details className="relative">
                <summary
                  aria-label="Conversation menu"
                  className="cursor-pointer list-none rounded-md px-2 py-1 text-sm"
                >
                  •••
                </summary>
                <Button
                  className="absolute top-8 right-0 z-20 shadow-sm"
                  disabled={busy}
                  onClick={archive}
                  size="sm"
                  variant="outline"
                >
                  Archive
                </Button>
              </details>
            ) : null}
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
          <div className="mx-auto flex max-w-2xl flex-col gap-5">
            {hasKey ? null : (
              <p className="rounded-lg border bg-muted/30 p-4 text-sm">
                The assistant needs your workspace's Anthropic key.{" "}
                <a className="underline" href="/settings/model-providers">
                  Open Model providers
                </a>{" "}
                to add it.
              </p>
            )}
            {conversation ? (
              <AssistantMessages
                agents={agents}
                conversation={conversation}
                disabled={busy}
                onResolve={resolve}
              />
            ) : (
              <div className="py-10 text-center">
                <Sparkles className="mx-auto mb-4 size-7 text-muted-foreground" />
                <h2 className="font-heading text-2xl">
                  What would you like to do?
                </h2>
                <p className="mx-auto mt-3 max-w-sm text-muted-foreground text-sm">
                  Create an agent, check on work, or change something in your
                  workspace.
                </p>
              </div>
            )}
            {manual ? (
              <AssistantCard
                agents={agents}
                card={manualCard}
                key={`manual-${manualVersion}`}
                onResolve={resolveManual}
              />
            ) : null}
            {busy ? (
              <p
                className="flex items-center gap-2 text-muted-foreground text-sm"
                role="status"
              >
                <Spinner className="size-3" />
                Working…
              </p>
            ) : null}
            {error ? (
              <div className="text-destructive text-sm" role="alert">
                <p>{error}</p>
                {error.includes("That looks like a key") && admin ? (
                  <Button
                    className="mt-2"
                    onClick={openManual}
                    size="sm"
                    variant="outline"
                  >
                    Add secret
                  </Button>
                ) : null}
              </div>
            ) : null}
            <div ref={bottom} />
          </div>
        </div>
        <div className="px-4 pb-3">
          <div className="mx-auto max-w-2xl">
            <StickyComposer background="bg-background">
              <form
                className="flex flex-col gap-2 md:border-t md:pt-4"
                onSubmit={send}
              >
                <Label htmlFor="assistant-message">Message</Label>
                <Textarea
                  autoComplete="off"
                  disabled={busy || !hasKey}
                  id="assistant-message"
                  maxLength={32_000}
                  onChange={changeText}
                  onKeyDown={submitOnSendShortcut}
                  placeholder="Ask about your workspace…"
                  value={text}
                />
                <div className="flex items-center gap-3">
                  <Button
                    disabled={busy || !hasKey || !text.trim()}
                    type="submit"
                  >
                    Send
                  </Button>
                  <SendHint />
                </div>
                <p className="text-muted-foreground text-xs">
                  Keep keys out of chat. Use Add secret to store one securely.
                </p>
              </form>
            </StickyComposer>
          </div>
        </div>
      </div>
    </section>
  );
}
