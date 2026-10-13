import { signAttachmentLink } from "#/modules/messaging/attachment-links";
import { routerStub } from "#/modules/router/agent-router";
import { AGENT_IMAGE_BASE_PATH, AGENT_IMAGE_DOMAIN } from "./route";

/**
 * Hands an agent an image it can see: a `user.message` with a caption and the
 * image as a `url` block, sent into the agent's running managed session. Tools
 * that take pictures (`browser_screenshot`, a later `computer_screenshot`) store
 * the bytes in `ATTACHMENTS` and call this with the R2 key; the content type
 * stored with the object is what the image route serves.
 *
 * Never throws: "no running session" and "the send failed" are answers the
 * tool puts in its result.
 */

export type ImageDelivery = { sent: true } | { reason: string; sent: false };

export interface SendImageInput {
  agentId: string;
  caption: string;
  /** Public origin the signed URL is built on, e.g. `PUBLIC_APP_URL`. */
  origin: string;
  r2Key: string;
  workspaceId: string;
}

/** Anthropic fetches the image right after the send; no need for longer. */
const LINK_TTL_SECONDS = 300;
const TRAILING_SLASHES = /\/+$/;

export const signedImageUrl = async (
  signingKey: string | undefined,
  origin: string,
  r2Key: string
): Promise<string> => {
  const link = await signAttachmentLink(signingKey, {
    domain: AGENT_IMAGE_DOMAIN,
    id: r2Key,
    ttlSeconds: LINK_TTL_SECONDS,
  });
  const query = new URLSearchParams({
    exp: String(link.expiresAt),
    key: r2Key,
    sig: link.signature,
  });
  return `${origin.replace(TRAILING_SLASHES, "")}${AGENT_IMAGE_BASE_PATH}?${query}`;
};

export const sendImageToAgentSession = async (
  env: Env,
  input: SendImageInput
): Promise<ImageDelivery> => {
  try {
    const imageUrl = await signedImageUrl(
      env.ATTACHMENT_LINK_KEY,
      input.origin,
      input.r2Key
    );
    return await routerStub(env, input.workspaceId).deliverImage({
      agentId: input.agentId,
      caption: input.caption,
      imageUrl,
    });
  } catch (error) {
    return {
      reason: error instanceof Error ? error.message : String(error),
      sent: false,
    };
  }
};
