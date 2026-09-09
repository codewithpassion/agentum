import type { Secret, SecretSyncStatus, SkillSyncStatus } from "./api";
import { formatRelativeTime } from "./format";

/**
 * The pure parts of the secrets screens: how a hint, a host list and a
 * last-used time are said, and how what somebody pastes into the host field
 * becomes a host the API will accept. Everything here is unit-tested; the
 * components around it only do I/O.
 *
 * Nothing in this file has any access to a secret's value - there is no field
 * to have access to. `hint` is the last four characters and the `…` in front of
 * it is added here, in the one place, so every screen says it the same way.
 */

/**
 * The server's own limits on a value, restated here so the form can refuse a
 * paste before the round trip rather than after it. They are not imported:
 * `modules/secrets/service.ts` reaches D1 and the encryption key, and none of
 * that belongs in a browser bundle. A test asserts the two agree, which is the
 * part that would otherwise drift.
 *
 * The minimum is not arbitrary: below it, the four-character hint would be most
 * of the secret.
 */
export const SECRET_VALUE_MIN_LENGTH = 8;
export const SECRET_VALUE_MAX_LENGTH = 4096;

/** The value is unreadable; the hint is the only part of it anyone ever sees. */
export const hintLabel = (hint: string): string => `…${hint}`;

/** A secret nobody has used yet has no last-used time, only a promise. */
export const lastUsedLabel = (
  lastUsedAt: string | null,
  now = Date.now()
): string =>
  lastUsedAt === null
    ? "never used"
    : `used ${formatRelativeTime(new Date(lastUsedAt).getTime(), now)}`;

/**
 * An empty allowlist means "nowhere", never "anywhere" - the API refuses to
 * store one, and saying it plainly is what keeps that rule visible.
 */
export const hostsLabel = (allowedHosts: readonly string[]): string =>
  allowedHosts.length === 0 ? "no hosts" : allowedHosts.join(", ");

/**
 * A secret's mirror has a third state the skills' dot does not ("unregistered",
 * meaning Anthropic has not been told about it yet), and the dot only speaks
 * three words. It maps onto "not synced yet", which is what it means.
 */
export const secretDotStatus = (status: SecretSyncStatus): SkillSyncStatus =>
  status === "unregistered" ? "unsynced" : status;

/**
 * What the mirror's state means for the owner, which is narrower than it looks:
 * the tool path reads D1 on every call, so a secret works whatever this says.
 * Only a *managed* agent's sandbox environment variable depends on the mirror.
 */
export const SECRET_SYNC_LABELS: Record<SecretSyncStatus, string> = {
  error: "not in the sandbox: sync failed",
  synced: "in agents' sandboxes",
  unregistered: "not in the sandbox yet",
};

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * What somebody typed, as a host the API will take. A pasted URL is the common
 * case - `https://api.deepgram.com/v1/listen` is what is in the other tab - so
 * the scheme and the path come off here rather than coming back as an error.
 *
 * Everything else is left exactly as typed: a port or a private address is
 * refused by the server with a reason worth reading, and quietly "fixing" it
 * would hide the rule that produced it.
 */
export const hostChipFrom = (raw: string): string => {
  const withoutScheme = raw.trim().replace(SCHEME, "");
  const [authority = ""] = withoutScheme.split("/");
  return authority.trim().toLowerCase();
};

/** Adding is idempotent: a host already on the list does not go on it twice. */
export const addHostChip = (
  hosts: readonly string[],
  raw: string
): string[] => {
  const host = hostChipFrom(raw);
  if (host.length === 0 || hosts.includes(host)) {
    return [...hosts];
  }
  return [...hosts, host];
};

/** One line for a sidebar row's tooltip: what it reaches, and when it last did. */
export const secretSummary = (secret: Secret, now = Date.now()): string =>
  `${secret.name} ${hintLabel(secret.hint)} · ${hostsLabel(secret.allowedHosts)} · ${lastUsedLabel(secret.lastUsedAt, now)}`;
