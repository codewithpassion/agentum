import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback, useRef } from "react";
import { toast } from "sonner";
import { SidebarTrigger } from "#/components/ui/sidebar.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import type { EmptyTaskView } from "#/integrations/trpc/types";
import { errorMessage } from "#/lib/error-message";
import { ComposerContainer } from "./composer-container.tsx";
import { ThreadContainer } from "./thread-container.tsx";
import { startRunBody } from "./thread-send.ts";
import {
  type ThreadSendInput,
  useTaskThreadRuntime,
} from "./use-task-thread-runtime.ts";

const NO_MESSAGES: never[] = [];
const refuseEdit = (): Promise<void> => Promise.resolve();

/**
 * A session that has no run yet, such as a new main thread: an empty history
 * and a composer. The first message starts the first run in this session, and
 * the route reloads into the full thread page.
 */
export function EmptyThread({ task }: { task: EmptyTaskView }) {
  const navigate = useNavigate();
  const router = useRouter();
  const starting = useRef<Promise<void> | null>(null);

  const send = useCallback(
    async ({ fileIds, text }: ThreadSendInput) => {
      // One send at a time, so a second Ctrl+Enter cannot start a second run.
      if (starting.current !== null) {
        throw new Error("The last message is still being sent.");
      }
      const begin = async () => {
        await getTrpc().runs.start.mutate(
          startRunBody({
            agentId: task.agent.id,
            fileIds,
            requestId: crypto.randomUUID(),
            session: task.session,
            text,
          })
        );
        await navigate({
          params: { sessionId: task.session.id },
          search: {},
          to: "/threads/$sessionId",
        });
        await router.invalidate();
      };
      starting.current = begin();
      try {
        await starting.current;
      } finally {
        starting.current = null;
      }
    },
    [navigate, router, task.agent.id, task.session]
  );
  const onError = useCallback(
    (cause: unknown) => toast.error(errorMessage(cause)),
    []
  );
  const runtime = useTaskThreadRuntime({
    messages: NO_MESSAGES,
    onEdit: refuseEdit,
    onError,
    onSend: send,
  });

  const composer = useCallback(
    () => <ComposerContainer disabledNote={null} nextRun={1} />,
    []
  );

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b px-4 py-2.5 md:px-6 md:py-3">
        <nav
          aria-label="Breadcrumb"
          className="mb-1 hidden items-center gap-2 text-muted-foreground text-sm md:flex"
        >
          <SidebarTrigger className="hidden size-6 md:inline-flex" />
          <Link to="/desk">Desk</Link> › Thread
        </nav>
        <h1 className="font-heading text-foreground text-xl">{task.title}</h1>
        <p className="text-muted-foreground text-xs">{task.agent.name}</p>
      </header>
      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadContainer composer={composer} />
      </AssistantRuntimeProvider>
    </section>
  );
}
