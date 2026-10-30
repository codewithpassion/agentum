// Sends an answer to a request. A request somebody else answered first is not an
// error: the card just closes.

import {
  type AnswerPayload,
  approvalAnswer,
  isConflict,
} from "#/components/requests/request-card-logic.ts";

/** Allow this one call. */
export const sendReplyAnswer = (): AnswerPayload =>
  approvalAnswer("allow_once", "");

/** Always allow this kind of call. */
export const alwaysSendAnswer = (): AnswerPayload =>
  approvalAnswer("always_allow", "");

/** Deny this call, with an optional note that is trimmed and left out when blank. */
export const notThisTimeAnswer = (note: string): AnswerPayload =>
  approvalAnswer("deny", note);

/**
 * Runs the answer mutation. A conflict (the request was answered elsewhere)
 * resolves with no send error. Any other error is thrown.
 */
export async function answerRequest(
  mutate: (
    input: AnswerPayload & { requestId: string }
  ) => Promise<{ sendError: string | null }>,
  requestId: string,
  payload: AnswerPayload
): Promise<{ sendError: string | null }> {
  try {
    return await mutate({ ...payload, requestId });
  } catch (cause) {
    if (isConflict(cause)) {
      return { sendError: null };
    }
    throw cause;
  }
}
