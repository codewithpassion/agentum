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
import { hmacKeyFromText, openClaims, signClaims } from "../crypto.ts";

/** A token for `claims`. Throws a ZodError when the claims are invalid. */
export const signViewToken = async (
  claims: ViewTokenClaims,
  key: string
): Promise<string> =>
  signClaims(
    await hmacKeyFromText(key),
    ARTIFACT_VIEW_TOKEN,
    viewTokenClaimsSchema.parse(claims)
  );

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
  const json = await openClaims(
    [await hmacKeyFromText(key)],
    ARTIFACT_VIEW_TOKEN,
    token
  );
  const parsed = viewTokenClaimsSchema.safeParse(json);
  if (!parsed.success || parsed.data.expiresAt <= nowSeconds) {
    return null;
  }
  return parsed.data;
};
