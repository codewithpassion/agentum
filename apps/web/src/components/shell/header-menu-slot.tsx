import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { SidebarTrigger } from "#/components/ui/sidebar";

/** Id of the site header element that holds the phone menu button. */
export const APP_HEADER_MENU_SLOT = "app-header-menu-slot";

/** Id of the site header element that holds Board, Find and New. */
export const APP_HEADER_ACTIONS_SLOT = "app-header-actions-slot";

/** Renders `children` inside the header element with this id, once it exists. */
function SlotPortal({ children, id }: { children: ReactNode; id: string }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setSlot(document.getElementById(id));
  }, [id]);

  return slot ? createPortal(children, slot) : null;
}

/** Renders the sidebar toggle inside the site header, on phones only. */
export function HeaderMenuButton() {
  return (
    <SlotPortal id={APP_HEADER_MENU_SLOT}>
      <SidebarTrigger className="size-10" />
    </SlotPortal>
  );
}

/** Renders the rail's Board, Find and New controls inside the site header. */
export function HeaderActionsPortal({ children }: { children: ReactNode }) {
  return <SlotPortal id={APP_HEADER_ACTIONS_SLOT}>{children}</SlotPortal>;
}

/** The empty header element the actions portal into. Only the app shell has one. */
export function HeaderActionsSlot({ inAppShell }: { inAppShell: boolean }) {
  return inAppShell ? (
    <div
      className="flex items-center gap-1.5 sm:gap-2"
      id={APP_HEADER_ACTIONS_SLOT}
    />
  ) : null;
}
