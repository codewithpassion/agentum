import { Bot } from "lucide-react";
import type { NavItem } from "../nav-registry.ts";

export const runtimeNav: readonly NavItem[] = [
  { icon: Bot, id: "agents", label: "Agents", to: "/agents" },
];
