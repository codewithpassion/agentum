import { KeyRound, Plug } from "lucide-react";
import type { NavItem } from "../nav-registry.ts";

// The access lane appends its entries to this array and nowhere else.
export const accessNav: readonly NavItem[] = [
  {
    icon: KeyRound,
    id: "api-keys",
    label: "API keys",
    to: "/settings/api-keys",
  },
  {
    icon: Plug,
    id: "connectors",
    label: "Connectors",
    to: "/connectors",
  },
];
