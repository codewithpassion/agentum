export const CHOOSE_ORGANIZATION_PATH = "/choose-organization";
const DEFAULT_TARGET = "/desk";
// Browsers drop tab, CR and LF while parsing a URL, so `/<tab>/host` would
// become `//host`. A backslash reads as a slash.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are the point
const CONTROL_OR_BACKSLASH = /[\u0000-\u001f\u007f\\]/;

/**
 * A same-origin path from a `redirect` query value, or undefined. Rejects
 * anything that could leave the origin: a scheme, `//host`, a backslash or a control character.
 */
export function safeRedirectPath(
  value: string | undefined
): string | undefined {
  if (
    value === undefined ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    CONTROL_OR_BACKSLASH.test(value)
  ) {
    return;
  }
  return value;
}

/** Where a person who picked a workspace goes: the page they asked for, or `/desk`. */
export function pickerTarget(redirect: string | undefined): string {
  return safeRedirectPath(redirect) ?? DEFAULT_TARGET;
}

/** The picker's URL, carrying the page the person was on so the pick can return to it. */
export function pickerPath(from: string): string {
  const safe = safeRedirectPath(from);
  return safe && !safe.startsWith(CHOOSE_ORGANIZATION_PATH)
    ? `${CHOOSE_ORGANIZATION_PATH}?redirect=${encodeURIComponent(safe)}`
    : CHOOSE_ORGANIZATION_PATH;
}
