/**
 * The view token (`ag_view_`, or `hm_view_` from before the rename) that lets a browser open one artifact version: the
 * claims as base64url JSON, a dot, then the base64url HMAC-SHA-256 of that
 * payload string. Pure Web Crypto. The key comes in as a parameter, so this
 * module never reads env.
 */

import {
  type ViewTokenClaims,
  viewTokenClaimsSchema,
} from "@repo/protocol/artifacts";
import { ARTIFACT_VIEW_TOKEN } from "@repo/protocol/token-prefixes";
import { constantTimeEqual, fromBase64Url, toBase64Url } from "../crypto.ts";

const HMAC = { hash: "SHA-256", name: "HMAC" } as const;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const hmacKey = (key: string): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", encoder.encode(key), HMAC, false, ["sign"]);

const mac = async (key: string, payload: string): Promise<Uint8Array> =>
  new Uint8Array(
    await crypto.subtle.sign(
      HMAC.name,
      await hmacKey(key),
      encoder.encode(payload)
    )
  );

/** A token for `claims`. Throws a ZodError when the claims are invalid. */
export const signViewToken = async (
  claims: ViewTokenClaims,
  key: string
): Promise<string> => {
  const payload = toBase64Url(
    encoder.encode(JSON.stringify(viewTokenClaimsSchema.parse(claims)))
  );
  return `${ARTIFACT_VIEW_TOKEN.issue}${payload}.${toBase64Url(await mac(key, payload))}`;
};

/**
 * The claims of `token` when it is signed with `key` and not expired at
 * `nowSeconds`, otherwise null. Never throws. The signature is checked before
 * the claims are parsed.
 */
export const verifyViewToken = async (
  token: string,
  key: string,
  nowSeconds: number
): Promise<ViewTokenClaims | null> => {
  const body = ARTIFACT_VIEW_TOKEN.strip(token);
  if (body === null) {
    return null;
  }
  const parts = body.split(".");
  const [payload, signatureText] = parts;
  if (parts.length !== 2 || !payload || !signatureText) {
    return null;
  }
  const signature = fromBase64Url(signatureText);
  if (!signature) {
    return null;
  }
  const expected = await mac(key, payload);
  if (!constantTimeEqual(expected, signature)) {
    return null;
  }
  const claimsBytes = fromBase64Url(payload);
  if (!claimsBytes) {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(decoder.decode(claimsBytes));
  } catch {
    return null;
  }
  const parsed = viewTokenClaimsSchema.safeParse(json);
  if (!parsed.success || parsed.data.expiresAt <= nowSeconds) {
    return null;
  }
  return parsed.data;
};
