import { artifactContentPath } from "@repo/protocol/artifacts";
import { signViewToken } from "@repo/services/artifacts/view-token";
import type { GuestCredential } from "@repo/services/live-guests/artifacts";
import { createGuestEmbeds } from "@repo/services/live-guests/embeds";
import type { Composed } from "../compose";
import { roomStub } from "./namespace";

export const guestEmbeds = (env: Env, composed: Composed) =>
  createGuestEmbeds({
    clock: composed.clock,
    db: composed.db,
    guestsOff: () =>
      Boolean((env as Env & { LIVE_GUESTS_OFF?: string }).LIVE_GUESTS_OFF),
    retained: async (scope) =>
      (await roomStub(env.ARTIFACT_ROOM, scope)).retainedDeckEmbeds(),
  });
export const resolveGuestEmbed = async (
  env: Env,
  composed: Composed,
  credential: GuestCredential,
  source: string
) => {
  if (!env.ARTIFACT_VIEW_KEY) {
    throw new Error("Guest embed unavailable");
  }
  const claims = await guestEmbeds(env, composed).resolve(credential, source);
  const token = await signViewToken(claims, env.ARTIFACT_VIEW_KEY);
  return {
    contentUrl: artifactContentPath({
      artifactId: claims.artifactId,
      path: claims.embedFile?.path ?? "",
      token,
    }),
    expiresAt: new Date(claims.expiresAt * 1000).toISOString(),
    recheckAfterMs: 2000,
  };
};
