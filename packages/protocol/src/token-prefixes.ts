// The prefixes of every secret and signed token the platform issues. New
// tokens start with `ag_`. Tokens issued before the rename start with `hm_`
// and stay valid, so every check that reads a prefix goes through `matches`,
// `strip` or `pattern` here and accepts both. Browser safe: plain strings.

/** The namespace of newly issued tokens. */
export const CURRENT_NAMESPACE = "ag_";
/** The namespace of tokens issued before the rename. Still accepted. */
export const LEGACY_NAMESPACE = "hm_";
/** Regex source for either namespace, for patterns that scan text. */
export const NAMESPACE_PATTERN = "(?:ag|hm)_";

export interface TokenPrefix {
  /** Both accepted prefixes, current first. */
  readonly accepted: readonly [string, string];
  /** `ag_<kind>_`. */
  readonly current: string;
  /** The prefix new tokens get. */
  readonly issue: string;
  /** `hm_<kind>_`. */
  readonly legacy: string;
  /** Whether `value` starts with either prefix. */
  readonly matches: (value: string) => boolean;
  /** Regex source matching either prefix, without anchors. */
  readonly pattern: string;
  /** The prefix `value` starts with, or null. */
  readonly prefixOf: (value: string) => string | null;
  /** `value` without its prefix, or null when it has neither. */
  readonly strip: (value: string) => string | null;
}

const tokenPrefix = (
  kind: string,
  issue: "current" | "legacy" = "current"
): TokenPrefix => {
  const current = `${CURRENT_NAMESPACE}${kind}_`;
  const legacy = `${LEGACY_NAMESPACE}${kind}_`;
  const prefixOf = (value: string) =>
    [current, legacy].find((prefix) => value.startsWith(prefix)) ?? null;
  return {
    accepted: [current, legacy],
    current,
    issue: issue === "current" ? current : legacy,
    legacy,
    matches: (value) => prefixOf(value) !== null,
    pattern: `${NAMESPACE_PATTERN}${kind}_`,
    prefixOf,
    strip: (value) => {
      const prefix = prefixOf(value);
      return prefix === null ? null : value.slice(prefix.length);
    },
  };
};

// Installed machine clients check the run token, machine credential and
// enroll code prefixes themselves, and they do not update on their own. These three keep being issued as `hm_`
// until clients that accept `ag_` are out; then drop the "legacy" argument.

/** Run tokens, `<prefix><payload>.<signature>`. */
export const RUN_TOKEN = tokenPrefix("run", "legacy");
/** Machine credentials. */
export const MACHINE_CREDENTIAL = tokenPrefix("mach", "legacy");
/** Single-use machine enroll codes. */
export const ENROLL_CODE = tokenPrefix("enr", "legacy");

/** Managed session tokens, signed like run tokens. */
export const SESSION_TOKEN = tokenPrefix("ses");
/** Platform API keys. */
export const API_KEY = tokenPrefix("key");
/** Trigger bearer tokens. */
export const TRIGGER_TOKEN = tokenPrefix("trg");
/** A2A access tokens. Valid only on `/a2a`. */
export const A2A_ACCESS_TOKEN = tokenPrefix("a2a");
/** A2A invite tokens. */
export const A2A_INVITE_TOKEN = tokenPrefix("inv");
/** Artifact view tokens, carried in the content URL. */
export const ARTIFACT_VIEW_TOKEN = tokenPrefix("view");
/** Artifact share link tokens, `/s/<token>`. */
export const ARTIFACT_SHARE_TOKEN = tokenPrefix("share");
/** Live artifact guest invitation tokens. */
export const GUEST_INVITATION_TOKEN = tokenPrefix("invite");
/** Live artifact guest session tokens. */
export const GUEST_SESSION_TOKEN = tokenPrefix("guest");
/** Live room admission headers. */
export const ROOM_ADMISSION = tokenPrefix("adm");
/** Live room tickets. */
export const ROOM_TICKET = tokenPrefix("room");

/** Whether `value` starts with either namespace, so it claims to be a platform token. */
export const isPlatformToken = (value: string): boolean =>
  value.startsWith(CURRENT_NAMESPACE) || value.startsWith(LEGACY_NAMESPACE);
