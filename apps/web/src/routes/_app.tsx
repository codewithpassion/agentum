import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import Footer from "#/components/footer";
import { AppSidebar } from "#/components/shell/app-sidebar";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "#/components/ui/sidebar";
import { getTrpc } from "#/integrations/trpc/client";

export const Route = createFileRoute("/_app")({
  // The sidebar lists the active agents. `agents.list` skips archived ones.
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

  return (
    <SidebarProvider>
      {/* The Needs you count reads 0 until V2.8 lands. */}
      <AppSidebar agents={agents} needsYouCount={0} />
      <SidebarInset>
        <div className="flex h-12 items-center border-border border-b px-4">
          <SidebarTrigger />
        </div>
        <div className="flex-1 px-4 py-6 sm:px-6">
          <Outlet />
        </div>
        <Footer shell />
      </SidebarInset>
    </SidebarProvider>
  );
}
