import {
  createFileRoute,
  Outlet,
  redirect,
  retainSearchParams,
} from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import type { CSSProperties } from "react";
import { z } from "zod";
import { AssistantPanel } from "#/components/assistant/assistant-panel";
import Footer from "#/components/footer";
import {
  DESK_POLL_INTERVAL_MS,
  usePolledQuery,
} from "#/components/inbox/use-polled-query";
import { Rail } from "#/components/rail/rail";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "#/components/ui/sidebar";
import { useTaskLayout } from "#/hooks/use-task-layout";
import { getTrpc } from "#/integrations/trpc/client";

/** The rail is wider than the old sidebar: it holds sentences. */
const RAIL_WIDTH = { "--sidebar-width": "20rem" } as CSSProperties;

export const Route = createFileRoute("/_app")({
  validateSearch: z.object({
    assistant: z.string().min(1).max(200).optional().catch(undefined),
  }),
  search: { middlewares: [retainSearchParams(["assistant"])] },
  // The rail's New task and Find list the active agents. `agents.list` skips archived ones.
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
    <SidebarProvider
      className={taskLayout ? "min-h-0 flex-1 overflow-hidden" : undefined}
      style={RAIL_WIDTH}
    >
      <AssistantPanel />
      <Rail agents={agents} pinned={pinned ?? []} />
      <SidebarInset className="min-h-0 min-w-0">
        {/* Desktop keeps this bar. On phones the menu button lives in the
            site header instead, so there is one bar. */}
        {taskLayout ? null : (
          <div className="hidden h-12 items-center border-border border-b px-4 md:flex">
            <SidebarTrigger />
          </div>
        )}
        <div
          className={
            taskLayout
              ? "flex min-h-0 flex-1 flex-col"
              : "flex-1 px-4 py-6 sm:px-6"
          }
        >
          <Outlet />
        </div>
        {taskLayout ? null : <Footer shell />}
      </SidebarInset>
    </SidebarProvider>
  );
}
