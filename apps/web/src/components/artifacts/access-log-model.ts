import type { ArtifactViewOutcome } from "@repo/db/shared";
import type { ArtifactShare, ArtifactView } from "@repo/protocol/artifacts";
import { formatTimestamp } from "./share-model.ts";

type PlaceFields = Pick<ArtifactView, "city" | "country" | "region">;
type NetworkFields = Pick<ArtifactView, "asn" | "asOrg" | "ipPrefix">;

export const OUTCOME_LABELS: Record<ArtifactViewOutcome, string> = {
  disabled: "Links off",
  error: "Error",
  expired: "Link expired",
  ok: "Opened",
  rate_limited: "Rate limited",
  refused: "Refused",
  revoked: "Link revoked",
};

export type OutcomeTone = "bad" | "ok" | "warn";

export function outcomeTone(outcome: ArtifactViewOutcome): OutcomeTone {
  if (outcome === "ok") {
    return "ok";
  }
  if (outcome === "error" || outcome === "refused") {
    return "bad";
  }
  return "warn";
}

/** "City, Region, Country" without the parts we don't have. */
export function describePlace(view: PlaceFields): string {
  const parts = [view.city, view.region, view.country].filter(
    (part): part is string => part !== null && part !== ""
  );
  return parts.length === 0 ? "Unknown" : parts.join(", ");
}

const AS_PREFIX = /^AS/i;

const networkName = (view: NetworkFields): string | null => {
  if (view.asOrg !== null && view.asOrg !== "") {
    return view.asOrg;
  }
  if (view.asn !== null && view.asn !== "") {
    return `AS${view.asn.replace(AS_PREFIX, "")}`;
  }
  return null;
};

/** The network name with the stored IP prefix. There is never a full IP. */
export function describeNetwork(view: NetworkFields): string {
  const name = networkName(view);
  if (name === null) {
    return view.ipPrefix ?? "Unknown";
  }
  return view.ipPrefix === null ? name : `${name} (${view.ipPrefix})`;
}

const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/Edg(?:e|A|iOS)?\//, "Edge"],
  [/(?:Chrome|CriOS)\//, "Chrome"],
  [/(?:Firefox|FxiOS)\//, "Firefox"],
  [/Safari\//, "Safari"],
];

const SYSTEMS: readonly (readonly [RegExp, string])[] = [
  [/Windows/, "Windows"],
  [/Android/, "Android"],
  [/iPhone|iPad|iPod|iOS/, "iOS"],
  [/Mac OS X|Macintosh|macOS/, "macOS"],
  [/Linux|X11/, "Linux"],
];

const firstMatch = (
  table: readonly (readonly [RegExp, string])[],
  text: string
): string | null => {
  for (const [pattern, label] of table) {
    if (pattern.test(text)) {
      return label;
    }
  }
  return null;
};

/** "Chrome on macOS", or "Unknown browser" when the agent string says nothing. */
export function describeBrowser(userAgent: string | null): string {
  if (userAgent === null) {
    return "Unknown browser";
  }
  const browser = firstMatch(BROWSERS, userAgent);
  if (browser === null) {
    return "Unknown browser";
  }
  const system = firstMatch(SYSTEMS, userAgent);
  return system === null ? browser : `${browser} on ${system}`;
}

const MEMBER_SURFACES: Record<ArtifactView["surface"], string> = {
  guest: "Guest",
  live_call: "Member, live call",
  room: "Room",
  share: "Member",
  test: "Member, artifact test",
  thread: "Member, in thread",
  viewer: "Member, in viewer",
};

/** Whose open this was: a link, or a member. */
export function describeWho(
  view: Pick<ArtifactView, "shareId" | "surface" | "userId"> &
    Partial<Pick<ArtifactView, "toolKey">>,
  shares: readonly Pick<ArtifactShare, "createdAt" | "id">[]
): string {
  if (view.shareId !== null) {
    const share = shares.find((candidate) => candidate.id === view.shareId);
    return share === undefined
      ? "Link (removed)"
      : `Link created ${formatTimestamp(share.createdAt)}`;
  }
  if (view.surface === "live_call" && view.userId === null) {
    const name = view.toolKey?.startsWith("endpoint:")
      ? view.toolKey.slice("endpoint:".length)
      : null;
    return name ? `Public endpoint ${name}` : "Public endpoint";
  }
  return view.userId === null ? "Unknown" : MEMBER_SURFACES[view.surface];
}

/** The label of a link in the filter. */
export function describeLink(
  share: Pick<ArtifactShare, "createdAt" | "status">
): string {
  const base = `Link created ${formatTimestamp(share.createdAt)}`;
  return share.status === "active" ? base : `${base} (${share.status})`;
}
