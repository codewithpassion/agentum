import type { ArtifactDetail } from "@repo/protocol/artifacts";

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
