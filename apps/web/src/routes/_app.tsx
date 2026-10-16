import { createFileRoute, Outlet } from "@tanstack/react-router";
import Footer from "#/components/footer";
import { AppSidebar } from "#/components/shell/app-sidebar";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "#/components/ui/sidebar";

export const Route = createFileRoute("/_app")({
  component: AppLayout,
});

function AppLayout() {
  return (
    <SidebarProvider>
      <AppSidebar />
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
