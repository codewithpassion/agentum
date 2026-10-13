/**
 * The divider the app posts when an agent starts a new session. Kept apart from
 * the server code that posts it so the web client can read the same constant.
 *
 * It is an ordinary message row: `origin` is free text, the author is
 * `external` with an id of `session:<agentId>`, and nothing is deleted, so the
 * history behind it stays readable with the channel tools.
 */
export const SESSION_START_ORIGIN = "session_start";

const AUTHOR_PREFIX = "session:";

export const sessionStartAuthorId = (agentId: string): string =>
  `${AUTHOR_PREFIX}${agentId}`;

export const sessionStartBody = (agentName: string): string =>
  `New session started for ${agentName}.`;

export const isSessionStartMessage = (message: { origin: string }): boolean =>
  message.origin === SESSION_START_ORIGIN;
