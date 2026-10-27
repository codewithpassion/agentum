import type { ArtifactKind } from "@repo/db/shared";
import {
  AppWindow,
  BookOpen,
  FileText,
  LayoutDashboard,
  type LucideIcon,
} from "lucide-react";

export const KIND_ICONS: Record<ArtifactKind, LucideIcon> = {
  app: AppWindow,
  dashboard: LayoutDashboard,
  doc: BookOpen,
  page: FileText,
};
