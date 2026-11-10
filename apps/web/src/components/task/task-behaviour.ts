import type { RunStatus } from "@repo/db/shared";
import { fileEntries } from "./files-logic.ts";
import type { TaskFilesView } from "./task-files.tsx";
import { statusPill } from "./task-logic.ts";
export type BottomState =
  | "composer"
  | "working"
  | "waiting"
  | "control"
  | "routing";

/** One strip, prioritising the person holding the live computer. */
export function bottomState({
  control,
  pending,
  working,
  origin,
  subThread = false,
}: {
  control: boolean;
  pending: string | null;
  working: boolean;
  origin: string;
  /** A thread an agent's hand-off started: it replies here whatever its origin. */
  subThread?: boolean;
}): BottomState {
  if (control) {
    return "control";
  }
  if (pending !== null) {
    return "waiting";
  }
  if (working) {
    return "working";
  }
  return origin === "ui" || subThread ? "composer" : "routing";
}

/** The split's available width excludes the rail. Below 920px use the tab. */
export const computerWidth = (available: number): number | null =>
  available < 920 ? null : Math.min(560, available - 560);

export const requestIsVisible = (
  top: number,
  bottom: number,
  viewportTop: number,
  viewportBottom: number
): boolean =>
  Math.max(0, Math.min(bottom, viewportBottom) - Math.max(top, viewportTop)) >=
  (bottom - top) / 2;

export function outsideLabel(kind: string, name: string): string | null {
  switch (kind) {
    case "mail":
      return name.startsWith("Mail from ") ? name : `Mail from ${name}`;
    case "trigger":
      return name.startsWith("Trigger:") ? name : `Trigger: ${name}`;
    case "slack":
      return "Slack";
    case "peer":
      return name ? `${name} (outside agent)` : "Outside agent";
    case "person":
    case "user":
    case "guest":
      return null;
    default:
      return name || "Outside input";
  }
}

export function focusRequest(id: string | undefined) {
  const card = document.getElementById(`thread-request-${id}`);
  card?.scrollIntoView({ block: "center" });
  const heading = card?.querySelector<HTMLElement>("[data-request-heading]");
  (heading ?? card)?.focus({ preventScroll: true });
}

export function taskStatus(
  status: RunStatus,
  pending: boolean,
  inControl: boolean
) {
  if (inControl) {
    return { text: "You have control", tone: "running" as const };
  }
  if (pending) {
    return { text: "Needs you", tone: "waiting" as const };
  }
  return statusPill(status);
}
export function filesSummary(
  files: TaskFilesView | null,
  artifacts: number
): string {
  const entries = files ? fileEntries(files.entries).length : 0;
  const parts: string[] = [];
  if (entries) {
    parts.push(`${entries} files in the task folder`);
  }
  if (files?.outside.length) {
    parts.push(`${files.outside.length} edited outside`);
  }
  if (files?.conflicts.length) {
    parts.push(
      `${files.conflicts.length} conflict${files.conflicts.length === 1 ? "" : "s"}`
    );
  }
  if (artifacts) {
    parts.push(`${artifacts} artifact${artifacts === 1 ? "" : "s"}`);
  }
  return parts.join(", ");
}

export const totalFiles = (
  files: TaskFilesView | null,
  artifacts: number
): number =>
  files === null
    ? artifacts
    : fileEntries(files.entries).length +
      files.outside.length +
      files.conflicts.length +
      artifacts;

/** Messages delivered by an outside channel keep that source, including linked Slack members. */
export function inputSourceKind(
  actor: string | undefined,
  starter: string
): string {
  if (["mail", "slack", "trigger", "peer"].includes(starter)) {
    return starter;
  }
  if (actor === "user" || actor === "guest" || actor === "peer") {
    return actor;
  }
  return starter;
}
