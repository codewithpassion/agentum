import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "#/components/secrets/secret-model";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "#/components/ui/sheet";
import { Spinner } from "#/components/ui/spinner";
import { getTrpc } from "#/integrations/trpc/client";
import { AssistantConversation } from "./assistant-conversation";
import { useAssistantLocation } from "./assistant-location";

async function loadAssistant(conversationId: string) {
  const client = getTrpc();
  const [initialList, initial, agents, key, me, mine] = await Promise.all([
    client.assistant.list.query(),
    conversationId === "new"
      ? null
      : client.assistant.get.query({ conversationId }),
    client.agents.list.query({ includeArchived: false }),
    client.managedKeys.status.query(),
    client.me.query(),
    client.workspaces.mine.query(),
  ]);
  return {
    admin: mine.some(
      (workspace) =>
        workspace.workspaceId === me.workspaceId &&
        workspace.role === "org:admin"
    ),
    agents,
    hasKey: key.configured,
    initial,
    initialList,
  };
}

/** Mounted only while open: no assistant or dictation requests on ordinary pages. */
function PanelConversation({ conversationId }: { conversationId: string }) {
  const [data, setData] = useState<Awaited<
    ReturnType<typeof loadAssistant>
  > | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    loadAssistant(conversationId).then(
      (next) => {
        if (live) {
          setData(next);
        }
      },
      (caught) => {
        if (live) {
          setError(errorMessage(caught));
        }
      }
    );
    return () => {
      live = false;
    };
  }, [conversationId]);
  if (error) {
    return (
      <p className="p-4 text-destructive" role="alert">
        {error}
      </p>
    );
  }
  return data ? (
    <AssistantConversation {...data} />
  ) : (
    <div className="p-4" role="status">
      <Spinner />
      Loading assistant…
    </div>
  );
}

export function AssistantPanel() {
  const { conversationId, open } = useAssistantLocation();
  const changeOpen = useCallback(
    (isOpen: boolean) => {
      if (!isOpen) {
        open(null);
      }
    },
    [open]
  );
  // The page and its top-bar toggle stay usable while the panel is open.
  const keepOpen = useCallback((event: Event) => event.preventDefault(), []);
  return (
    <Sheet
      modal={false}
      onOpenChange={changeOpen}
      open={conversationId !== null}
    >
      <SheetContent
        className="gap-0 bg-background data-[side=right]:w-full data-[side=right]:sm:max-w-none md:data-[side=right]:top-(--app-header-h) md:data-[side=right]:h-[calc(100dvh-var(--app-header-h))] md:data-[side=right]:w-[760px]"
        onInteractOutside={keepOpen}
        side="right"
      >
        <SheetHeader className="shrink-0 border-b pr-12">
          <SheetTitle>Assistant</SheetTitle>
          <SheetDescription className="sr-only">
            Your private workspace assistant
          </SheetDescription>
        </SheetHeader>
        {conversationId ? (
          <PanelConversation
            conversationId={conversationId}
            key={conversationId}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
