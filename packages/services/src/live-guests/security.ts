/** Credential primitives only. No credential is logged or included in a URL here. */
import { hashedToken, toBase64Url } from "../crypto.ts";

export const GUEST_COOKIE = "__Host-hm_guest";
export const GUEST_SESSION_SECONDS = 12 * 60 * 60;
export const GUEST_CODE_SECONDS = 10 * 60;
export const GUEST_CODE_TRIES = 5;
const CODE = /^\d{6}$/;
const SESSION = /^hm_guest_[A-Za-z0-9_-]{43}$/;
const encoder = new TextEncoder();

export const newInvitationToken = () => hashedToken("hm_invite_");
export const newGuestSessionToken = () => hashedToken("hm_guest_");

/** Rejection sampling avoids modulo bias in the six decimal digits. */
export const newGuestCode = (): string => {
  const ceiling = Math.floor(2 ** 32 / 1_000_000) * 1_000_000;
  const word = new Uint32Array(1);
  do {
    crypto.getRandomValues(word);
  } while ((word[0] ?? ceiling) >= ceiling);
  return ((word[0] ?? 0) % 1_000_000).toString().padStart(6, "0");
};

export interface GuestCodeBinding {
  codeId: string;
  guestId: string;
  inviteId: string;
  workspaceId: string;
}

/** A private, >=32-byte pepper prevents offline enumeration of a six-digit space.
 * Binding to the challenge and invitation prevents hash transplantation/replay.
 * This is not a verifier: consuming a code and charging attempts must be atomic.
 */
export const createGuestCodeHasher = async (
  pepper: Uint8Array<ArrayBuffer>
) => {
  if (pepper.byteLength < 32) {
    throw new Error(
      "A private guest code pepper of at least 32 bytes is required"
    );
  }
  const key = await crypto.subtle.importKey(
    "raw",
    pepper,
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"]
  );
  return async (code: string, binding: GuestCodeBinding): Promise<string> => {
    if (!CODE.test(code)) {
      throw new Error("Invalid guest code format");
    }
    const bytes = encoder.encode(
      JSON.stringify([
        "guest-code-v1",
        binding.workspaceId,
        binding.guestId,
        binding.inviteId,
        binding.codeId,
        code,
      ])
    );
    return toBase64Url(
      new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes))
    );
  };
};

/** Set only after an atomic sign-in or rotation succeeds. No Domain attribute. */
export const guestSessionCookie = (
  token: string,
  maxAge = GUEST_SESSION_SECONDS
): string => {
  if (
    !(SESSION.test(token) && Number.isSafeInteger(maxAge)) ||
    maxAge < 1 ||
    maxAge > GUEST_SESSION_SECONDS
  ) {
    throw new Error("Invalid guest session cookie");
  }
  return `${GUEST_COOKIE}=${token}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
};
export const clearGuestSessionCookie = (): string =>
  `${GUEST_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;

/** Private keyed abuse-ledger subjects. Keep the pepper stable for at least the
 * longest active rate window; rotating it requires retiring existing windows.
 */
export const createGuestRateHasher = async (
  pepper: Uint8Array<ArrayBuffer>
) => {
  if (pepper.byteLength < 32) {
    throw new Error(
      "A private guest code pepper of at least 32 bytes is required"
    );
  }
  const key = await crypto.subtle.importKey(
    "raw",
    pepper,
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"]
  );
  return async (input: {
    workspaceId: string;
    kind: string;
    seconds: number;
    subject: string;
  }) =>
    toBase64Url(
      new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          key,
          encoder.encode(
            JSON.stringify([
              "guest-rate-v1",
              input.workspaceId,
              input.kind,
              input.seconds,
              input.subject,
            ])
          )
        )
      )
    );
};
