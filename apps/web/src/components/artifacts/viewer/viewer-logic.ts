import type { ArtifactDetail, ArtifactVersion } from "@repo/protocol/artifacts";

/** `?v=<n>`: a positive whole number, otherwise nothing. */
export function parseVersionSearch(raw: unknown): number | undefined {
  const value = typeof raw === "string" && raw !== "" ? Number(raw) : raw;
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

/** The version on screen: the `?v` one, else the current one. */
export function shownVersionNumber(
  detail: Pick<ArtifactDetail, "currentVersion">,
  v: number | undefined
): number {
  return v ?? detail.currentVersion.number;
}

/** `/a/<id>`, with `?v=<n>` for an older version only. */
export function buildViewerPath(
  artifactId: string,
  v: number | undefined,
  currentNumber: number
): string {
  return v === undefined || v === currentNumber
    ? `/a/${artifactId}`
    : `/a/${artifactId}?v=${v}`;
}

/** The zip of one version's files. */
export function downloadPath(artifactId: string, version: number): string {
  return `/api/artifacts/${artifactId}/download?version=${version}`;
}

export interface Byline {
  agent: string | null;
  owner: string;
  task: { runId: string; title: string | null } | null;
}

/** "by <owner> · made by <agent> in <task>", as parts. */
export function byline(
  detail: Pick<ArtifactDetail, "agentName" | "madeIn" | "ownerName">
): Byline {
  return {
    agent: detail.agentName,
    owner: detail.ownerName ?? "someone",
    task: detail.madeIn
      ? { runId: detail.madeIn.runId, title: detail.madeIn.title }
      : null,
  };
}

/** The plain word for a version that is not published, else nothing. */
export function versionStatusBadge(
  status: ArtifactVersion["status"]
): string | null {
  if (status === "published") {
    return null;
  }
  return status === "proposed" ? "Proposed" : status;
}

/** "v3", or "v3 (proposed)" for a version that is not published. */
export function versionOptionLabel(
  version: Pick<ArtifactVersion, "number" | "status">
): string {
  return version.status === "published"
    ? `v${version.number}`
    : `v${version.number} (${version.status})`;
}

export type PromoteState = "idle" | "waiting" | "working";

/** The Promote button for a state: its label and whether it can be pressed. */
export function promoteButton(state: PromoteState): {
  disabled: boolean;
  label: string;
} {
  if (state === "waiting") {
    return { disabled: true, label: "Waiting for approval" };
  }
  if (state === "working") {
    return { disabled: true, label: "Promoting..." };
  }
  return { disabled: false, label: "Promote" };
}

/** Promote shows for a proposed version, to someone who manages the artifact. */
export function canPromote(
  detail: Pick<ArtifactDetail, "canManage">,
  version: Pick<ArtifactVersion, "status"> | undefined
): boolean {
  return detail.canManage && version?.status === "proposed";
}
