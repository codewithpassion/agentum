import { useCallback, useEffect, useState } from "react";
import { ThreadsCard } from "#/components/agent/profile/threads-card.tsx";
import { TaskPage } from "#/components/task/task-page.tsx";
import { EmptyThread } from "#/components/thread/empty-thread.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import type { EmptyTaskView, TaskView } from "#/integrations/trpc/types";
import { errorMessage } from "#/lib/error-message";
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

  // A send stays in the room: read the thread again and show its new run.
  const sessionId = main.status === "ready" ? main.task.session.id : null;
  const refresh = useCallback(async () => {
    if (sessionId === null) {
      return;
    }
    try {
      setMain({ status: "ready", task: await readTask(sessionId) });
    } catch (cause) {
      setMain({ message: errorMessage(cause), status: "error" });
    }
  }, [sessionId]);

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

export function ChatTab({ room }: RoomTabProps) {
  const { agent, threads } = room;
  return (
    <div className="flex min-w-0 flex-col gap-4 md:flex-row md:items-start">
      <div className="min-w-0 md:w-80 md:shrink-0">
        <ThreadsCard
          agent={agent}
          archived={agent.status === "archived"}
          threads={threads}
        />
      </div>
      <div className="flex h-[70vh] min-h-96 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border">
        <MainThread
          agentId={agent.id}
          archived={agent.status === "archived"}
          key={agent.id}
        />
      </div>
    </div>
  );
}
