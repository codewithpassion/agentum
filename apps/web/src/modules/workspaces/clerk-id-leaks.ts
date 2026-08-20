/**
 * The "never show the Clerk user id" rule, as something a test can assert
 * against a whole response body rather than field by field.
 *
 * Two things count as a leak: a field *named* for the Clerk id, and a value
 * that looks like one (`user_` followed by Clerk's opaque suffix). Paths are
 * returned rather than a boolean so a failure names the field that leaked.
 *
 * One known, accepted exception is deliberately not detectable here: a
 * Clerk-hosted `imageUrl` (`https://img.clerk.com/eyJ0eXBl…`) carries a
 * base64url token whose payload contains `"rid":"user_…"`. The id is encoded,
 * not literal, so this scan passes it - see the Phase 4 note in
 * `docs/plan-multi-tenancy.md`: proxying those images is future work, and no
 * API or UI *field* carries the id.
 */

/** Clerk ids are `user_` plus an opaque suffix; a bare "user_" is not one. */
const CLERK_ID = /user_[A-Za-z0-9]{4,}/;

const FORBIDDEN_KEYS = new Set(["clerkUserId", "clerk_user_id"]);

const leaksIn = (value: unknown, path: string, found: string[]): void => {
  if (typeof value === "string") {
    if (CLERK_ID.test(value)) {
      found.push(`${path} = ${JSON.stringify(value)}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      leaksIn(entry, `${path}[${index}]`, found);
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const child = `${path}.${key}`;
    if (FORBIDDEN_KEYS.has(key)) {
      found.push(`${child} (forbidden field)`);
    }
    leaksIn(entry, child, found);
  }
};

/** Every path in `value` that carries a Clerk user id; empty means clean. */
export const findClerkIdLeaks = (value: unknown): string[] => {
  const found: string[] = [];
  leaksIn(value, "$", found);
  return found;
};

/** The same check over a raw response body, which is how routes are tested. */
export const findClerkIdLeaksInBody = (body: string): string[] => {
  try {
    return findClerkIdLeaks(JSON.parse(body));
  } catch {
    // Not JSON (a file download, an empty 204): scan the text as it stands.
    return CLERK_ID.test(body) ? ["$ (raw body)"] : [];
  }
};
