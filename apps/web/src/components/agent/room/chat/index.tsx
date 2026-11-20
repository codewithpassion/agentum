import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ThreadsCard } from "#/components/agent/profile/threads-card.tsx";
import { TaskPage } from "#/components/task/task-page.tsx";
import { EmptyThread } from "#/components/thread/empty-thread.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import type { EmptyTaskView, TaskView } from "#/integrations/trpc/types";
import { errorMessage } from "#/lib/error-message";
import { NowPanel } from "../now/index.tsx";
import type { RoomTabProps } from "../room-data.ts";

type Main =
  | { message: string; status: "error" }
  | { status: "loading" }
  | { status: "ready"; task: EmptyTaskView | TaskView };

const readTask = (sessionId: string) =>
  getTrpc().tasks.get.query({ sessionId });

function MainThread({
  agentId,
  archived,
}: {
  agentId: string;
  archived: boolean;
}) {
  const [main, setMain] = useState<Main>({ status: "loading" });

  // `sessions.main` makes the caller's main thread on first use.
  useEffect(() => {
    if (archived) {
      return;
    }
    let active = true;
    getTrpc()
      .sessions.main.mutate({ agentId })
      .then((session) => readTask(session.id))
      .then((view) => {
        if (active) {
          setMain({ status: "ready", task: view });
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setMain({ message: errorMessage(cause), status: "error" });
        }
      });
    return () => {
      active = false;
    };
  }, [agentId, archived]);

  // A send stays in the room: read the thread again and show its new run, and
  // reload the room so Work and the conversation list see the new task.
  const router = useRouter();
  const sessionId = main.status === "ready" ? main.task.session.id : null;
  const refresh = useCallback(async () => {
    if (sessionId === null) {
      return;
    }
    try {
      setMain({ status: "ready", task: await readTask(sessionId) });
    } catch (cause) {
      setMain({ message: errorMessage(cause), status: "error" });
      return;
    }
    try {
      await router.invalidate();
    } catch (cause) {
      toast.error(errorMessage(cause, "Could not refresh the page."));
    }
  }, [router, sessionId]);

  if (archived) {
    return (
      <p className="text-muted-foreground text-sm">
        This agent is archived, so it takes no new messages.
      </p>
    );
  }
  if (main.status === "loading") {
    return (
      <p className="text-muted-foreground text-sm">Opening the conversation.</p>
    );
  }
  if (main.status === "error") {
    return <p className="text-destructive text-sm">{main.message}</p>;
  }
  const { task } = main;
  if (task.run === null) {
    return <EmptyThread onSent={refresh} task={task} />;
  }
  // A new latest run (a reply) starts the live state over.
  return (
    <TaskPage embedded initial={task} key={task.run.id} onSent={refresh} />
  );
}

export function ChatTab({ nowMs, room }: RoomTabProps) {
  const { agent, threads } = room;
  const archived = agent.status === "archived";
  return (
    <div
      className={`grid min-w-0 gap-4 md:grid-cols-[20rem_minmax(0,1fr)] md:items-start ${archived ? "" : "xl:grid-cols-[20rem_minmax(0,1fr)_18rem]"}`}
    >
      <div className="min-w-0">
        <ThreadsCard agent={agent} archived={archived} threads={threads} />
      </div>
      <div className="flex h-[70vh] min-h-96 min-w-0 flex-col overflow-hidden rounded-lg border border-border">
        <MainThread agentId={agent.id} archived={archived} key={agent.id} />
      </div>
      {archived ? null : (
        <div className="order-first min-w-0 md:col-span-2 xl:order-none xl:col-span-1">
          <NowPanel nowMs={nowMs} room={room} />
        </div>
      )}
    </div>
  );
}
