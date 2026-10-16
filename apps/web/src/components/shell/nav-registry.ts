import type { LucideIcon } from "lucide-react";
import { accessNav } from "./nav/access.ts";
import { automationNav } from "./nav/automation.ts";
import { runtimeNav } from "./nav/runtime.ts";

export interface NavItem {
  icon: LucideIcon;
  id: string;
  label: string;
  to: string;
}

export const navItems: readonly NavItem[] = [
  ...runtimeNav,
  ...accessNav,
  ...automationNav,
];
