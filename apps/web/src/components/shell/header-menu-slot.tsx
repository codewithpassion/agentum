import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { SidebarTrigger } from "#/components/ui/sidebar";

/** Id of the site header element that holds the phone menu button. */
export const APP_HEADER_MENU_SLOT = "app-header-menu-slot";

/** Renders the sidebar toggle inside the site header, on phones only. */
export function HeaderMenuButton() {
  const [slot, setSlot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setSlot(document.getElementById(APP_HEADER_MENU_SLOT));
  }, []);

  return slot
    ? createPortal(<SidebarTrigger className="size-10" />, slot)
    : null;
}
