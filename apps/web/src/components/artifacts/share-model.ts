import type {
  ArtifactShare,
  ArtifactsCreateShareInput,
} from "@repo/protocol/artifacts";
import { format } from "date-fns";

/** The expiry choices of the "Create link" form, in display order. */
export const EXPIRY_CHOICES = ["never", "1d", "7d", "30d", "date"] as const;
export type ExpiryChoice = (typeof EXPIRY_CHOICES)[number];

export const EXPIRY_LABELS: Record<ExpiryChoice, string> = {
  "1d": "1 day",
  "7d": "7 days",
  "30d": "30 days",
  date: "A date",
  never: "Never",
};

/** A new link expires after a week unless the person picks otherwise. */
export const DEFAULT_EXPIRY: ExpiryChoice = "7d";

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRY_DAYS: Partial<Record<ExpiryChoice, number>> = {
  "1d": 1,
  "7d": 7,
  "30d": 30,
};
const DATE_VALUE = /^(\d{4})-(\d{2})-(\d{2})$/;

export type ExpiryResult =
  | { expiresAt: string | null; ok: true }
  | { error: string; ok: false };

/**
 * Turns an expiry choice into the `expiresAt` the server takes. `date` is the
 * value of a date input (`YYYY-MM-DD`); the link then ends at the close of
 * that day in the person's time zone.
 */
export function resolveExpiry(
  choice: ExpiryChoice,
  date: string,
  now: Date
): ExpiryResult {
  if (choice === "never") {
    return { expiresAt: null, ok: true };
  }
  const days = EXPIRY_DAYS[choice];
  if (days !== undefined) {
    return {
      expiresAt: new Date(now.getTime() + days * DAY_MS).toISOString(),
      ok: true,
    };
  }
  const match = DATE_VALUE.exec(date);
  if (match === null) {
    return { error: "Pick the date the link should end.", ok: false };
  }
  const [, year, month, day] = match;
  const end = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    23,
    59,
    59,
    999
  );
  if (Number.isNaN(end.getTime()) || end.getTime() <= now.getTime()) {
    return { error: "Pick a date that is not in the past.", ok: false };
  }
  return { expiresAt: end.toISOString(), ok: true };
}

export type CreateShareResult =
  | { input: ArtifactsCreateShareInput; ok: true }
  | { error: string; ok: false };

/**
 * The `createShare` input for the form. Following the latest version sends
 * `versionId: null`; pinning sends the id of the version being viewed.
 * Phase 2 adds the data choice here: it sets `dataMode` and `liveTools`.
 */
export function buildCreateShareInput({
  artifactId,
  currentVersionId,
  date,
  expiry,
  now,
  pin,
}: {
  artifactId: string;
  currentVersionId: string;
  date: string;
  expiry: ExpiryChoice;
  now: Date;
  pin: boolean;
}): CreateShareResult {
  const resolved = resolveExpiry(expiry, date, now);
  if (!resolved.ok) {
    return resolved;
  }
  return {
    input: {
      artifactId,
      dataMode: "snapshot",
      expiresAt: resolved.expiresAt,
      versionId: pin ? currentVersionId : null,
    },
    ok: true,
  };
}

/** What the revoke confirmation says. Revoke never runs on one tap. */
export function revokeConfirmCopy(share: ArtifactShare) {
  const opens = share.openCount === 1 ? "1 time" : `${share.openCount} times`;
  return {
    confirmLabel: "Revoke link",
    description: `Anyone who opens this link will see "This link is not available." It was opened ${opens}. You cannot undo this, but you can create a new link.`,
    title: "Revoke this link?",
  };
}

/** Only an organisation admin sees a working link-sharing switch. */
export const canToggleLinks = (orgRole: string | null | undefined): boolean =>
  orgRole === "org:admin";

/** "Follows latest" or "Pinned to v3". `numbers` maps version ids to numbers. */
export function shareVersionLabel(
  share: ArtifactShare,
  numbers: ReadonlyMap<string, number>
): string {
  if (share.versionId === null) {
    return "Follows latest";
  }
  const number = numbers.get(share.versionId);
  return number === undefined ? "Pinned" : `Pinned to v${number}`;
}

export const SHARE_STATUS_LABELS: Record<ArtifactShare["status"], string> = {
  active: "Active",
  expired: "Expired",
  revoked: "Revoked",
};

/** A timestamp for tables and logs, in the viewer's time zone. */
export const formatTimestamp = (iso: string | null): string =>
  iso === null ? "Never" : format(new Date(iso), "d MMM yyyy, HH:mm");

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong.";
