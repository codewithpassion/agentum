import {
  Bot,
  Cloud,
  FolderOpen,
  KeyRound,
  MessagesSquare,
  ScrollText,
  Server,
  Sparkles,
} from "lucide-react";
import type { NavItem } from "../nav-registry.ts";

export const runtimeNav: readonly NavItem[] = [
  { icon: Bot, id: "agents", label: "Agents", to: "/agents" },
  { icon: MessagesSquare, id: "sessions", label: "Sessions", to: "/sessions" },
  { icon: Server, id: "machines", label: "Machines", to: "/machines" },
  {
    icon: Cloud,
    id: "managed-agents",
    label: "Anthropic",
    to: "/settings/managed-agents",
  },
  { icon: KeyRound, id: "secrets", label: "Secrets", to: "/settings/secrets" },
  { icon: FolderOpen, id: "library", label: "Library", to: "/library" },
  { icon: Sparkles, id: "skills", label: "Skills", to: "/skills" },
  { icon: ScrollText, id: "log", label: "Log", to: "/log" },
];
