/**
 * Where a published agent lives, and the tokens of a pairing. Pure string
 * work, no database.
 */

export const ACCESS_TOKEN_PREFIX = "hm_a2a_";
export const INVITE_TOKEN_PREFIX = "hm_inv_";

const CARD_FILE = "/.well-known/agent-card.json";
const TRAILING_SLASHES = /\/+$/;
const CONNECTION_PATH = /^\/connect\/([^/]+)$/;
const CARD_PATH = /^\/a2a\/([^/]+)(?:\/|$)/;
const INVITE_TOKEN = /^hm_inv_(con_[0-9A-Za-z]+)\.[A-Za-z0-9_-]+$/;

/** The interface base of a published agent: `https://<host>/a2a/<publicId>`. */
export const interfaceBase = (baseUrl: string, publicId: string): string =>
  `${baseUrl.replace(TRAILING_SLASHES, "")}/a2a/${publicId}`;

/** The link an invite is shared as. */
export const connectLinkOf = (baseUrl: string, token: string): string =>
  `${baseUrl.replace(TRAILING_SLASHES, "")}/connect/${token}`;

/** The card URL a peer fetches. */
export const cardUrlOf = (baseUrl: string, publicId: string): string =>
  `${interfaceBase(baseUrl, publicId)}${CARD_FILE}`;

/** The interface base of a card URL: the URL without the card file name. */
export const interfaceBaseOfCardUrl = (cardUrl: string): string => {
  const url = new URL(cardUrl);
  const path = url.pathname.endsWith(CARD_FILE)
    ? url.pathname.slice(0, -CARD_FILE.length)
    : url.pathname;
  return `${url.origin}${path.replace(TRAILING_SLASHES, "")}`;
};

/** The public id in a card URL on this deployment, or null for a URL of another shape. */
export const publicIdOfCardUrl = (cardUrl: string): string | null => {
  const match = CARD_PATH.exec(new URL(cardUrl).pathname);
  return match?.[1] ?? null;
};

/** Whether `url` is on the same origin as `baseUrl`. False when there is no base. */
export const isOnOrigin = (url: string, baseUrl: string): boolean => {
  if (baseUrl === "") {
    return false;
  }
  return new URL(url).origin === new URL(baseUrl).origin;
};

/** The invite token and the origin of the deployment that issued it, from a pasted link. */
export const parseInviteLink = (
  link: string
): { inviteToken: string; origin: string } | null => {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  const match = CONNECTION_PATH.exec(url.pathname);
  const inviteToken = match?.[1];
  if (!inviteToken || connectionIdOfInvite(inviteToken) === null) {
    return null;
  }
  return { inviteToken, origin: url.origin };
};

/**
 * The connection an invite token belongs to. The id travels in the token so a
 * wrong secret can still be counted against its invite.
 */
export const connectionIdOfInvite = (inviteToken: string): string | null =>
  INVITE_TOKEN.exec(inviteToken)?.[1] ?? null;
