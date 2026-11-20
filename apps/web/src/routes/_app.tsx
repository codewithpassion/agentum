import {
  createFileRoute,
  Outlet,
  retainSearchParams,
} from "@tanstack/react-router";
import { z } from "zod";
import { AssistantPanel } from "#/components/assistant/assistant-panel";
import Footer from "#/components/footer";
import {
  DESK_POLL_INTERVAL_MS,
  usePolledQuery,
} from "#/components/inbox/use-polled-query";
import { AppTopBar } from "#/components/shell/app-top-bar";
import { useTaskLayout } from "#/hooks/use-task-layout";
import { getTrpc } from "#/integrations/trpc/client";
import { loadOrLogin } from "#/integrations/trpc/load-or-login";
import { cn } from "#/lib/utils";

export const Route = createFileRoute("/_app")({
  validateSearch: z.object({
    assistant: z.string().min(1).max(200).optional().catch(undefined),
  }),
  search: { middlewares: [retainSearchParams(["assistant"])] },
  // Find lists the active agents. `agents.list` skips archived ones.
  loader: async () =>
    loadOrLogin(async () => await getTrpc().agents.list.query({})),
  component: AppLayout,
});

function AppLayout() {
  const agents = Route.useLoaderData();
  const taskLayout = useTaskLayout();
  const { data: pinned } = usePolledQuery(
    () => getTrpc().artifacts.pins.query({ surface: "sidebar" }),
    null,
    DESK_POLL_INTERVAL_MS
  );

  return (
    <div
      className={cn(
        "flex min-w-0 flex-col",
        taskLayout ? "min-h-0 flex-1 overflow-hidden" : "min-h-svh"
      )}
    >
      <AssistantPanel />
      <AppTopBar agents={agents} pinned={pinned ?? []} />
      <main
        className={
          taskLayout
            ? "flex min-h-0 flex-1 flex-col"
            : "min-w-0 flex-1 px-4 py-6 sm:px-6"
        }
      >
        <Outlet />
      </main>
      {taskLayout ? null : <Footer shell />}
    </div>
  );
}
