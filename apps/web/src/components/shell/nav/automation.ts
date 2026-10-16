import { CalendarClock, Webhook } from "lucide-react";
import type { NavItem } from "../nav-registry.ts";

// The automation lane appends its entries to this array and nowhere else.
export const automationNav: readonly NavItem[] = [
  {
    icon: Webhook,
    id: "triggers",
    label: "Triggers",
    to: "/triggers",
  },
  {
    icon: CalendarClock,
    id: "routines",
    label: "Routines",
    to: "/routines",
  },
];
