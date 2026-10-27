import type { ArtifactKind } from "@repo/db/shared";
import type {
  ArtifactCard,
  ArtifactsListInput,
} from "@repo/protocol/artifacts";

export const KIND_LABELS: Record<ArtifactKind, string> = {
  app: "App",
  dashboard: "Dashboard",
  doc: "Doc",
  page: "Page",
};

export type MadeBy = "agent" | "person";

/** The list filters the page keeps in its URL. */
export interface ArtifactFilters {
  kind?: ArtifactKind | undefined;
  madeBy?: MadeBy | undefined;
  shared?: true | undefined;
}

/** Where the viewer for an artifact lives. A plain link: the viewer sits outside the app shell. */
export const artifactHref = (artifactId: string): string => `/a/${artifactId}`;

/** The thumbnail route. Only cards with `hasThumbnail` use it. */
export const thumbnailSrc = (artifactId: string): string =>
  `/api/artifacts/${artifactId}/thumbnail`;

/** The badges on a card: its audience, plus "Link" while an active link exists. */
export const audienceBadges = (
  card: Pick<ArtifactCard, "audience" | "linkCount">
): string[] => {
  const badges = [card.audience === "private" ? "Private" : "Workspace"];
  if (card.linkCount > 0) {
    badges.push("Link");
  }
  return badges;
};

/** Owner and maker as one line: "Dana", or "Dana · made by Scout". */
export const byLine = (
  card: Pick<ArtifactCard, "agentName" | "ownerName">
): string => {
  const owner = card.ownerName ?? "Unknown";
  return card.agentName === null
    ? owner
    : `${owner} · made by ${card.agentName}`;
};

/** The `artifacts.list` input for a set of filters and an optional cursor. */
export const listInput = (
  filters: ArtifactFilters,
  cursor?: string
): ArtifactsListInput => ({
  ...(cursor === undefined ? {} : { cursor }),
  ...(filters.kind === undefined ? {} : { kind: filters.kind }),
  ...(filters.madeBy === undefined ? {} : { madeBy: filters.madeBy }),
  ...(filters.shared === true ? { shared: true } : {}),
});

export const hasFilters = (filters: ArtifactFilters): boolean =>
  filters.kind !== undefined ||
  filters.madeBy !== undefined ||
  filters.shared === true;
