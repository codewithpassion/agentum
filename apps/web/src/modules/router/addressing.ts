/**
 * "Was that meant for me?" - the question a thread makes reasonable to ask.
 *
 * In a channel, an agent is addressed by name: that is what a mention is for,
 * and guessing would mean waking on every passing message. A thread is narrower.
 * Somebody who replies under an agent's answer is almost always still talking
 * to it, and having to write `@Bruce` every time reads as ceremony.
 *
 * So the rule is scoped twice over, and both halves matter:
 *
 * - only in a thread the agent has already spoken in. No participation, no
 *   question - which keeps this off the vast majority of messages, and keeps
 *   an agent from wandering into a conversation that was never its own;
 * - only to decide between waking *now* and waking in the next digest. A "no"
 *   is not a message dropped; it is the behaviour we already had.
 *
 * The prompt and the parsing live here, apart from the model call, so what
 * counts as an answer is pinned by tests rather than by a live API.
 */

export interface AddressingCandidate {
  agentId: string;
  name: string;
}

export interface ThreadTurn {
  authorName: string;
  body: string;
}

/** Enough thread for the question to be answerable, not so much it costs. */
const MAX_TURNS = 12;
const MAX_BODY = 400;

/** What the model says when the message was not for any of them. */
export const NOBODY = "NOBODY";

export const ADDRESSING_SYSTEM = [
  "You decide whether a message in a chat thread is addressed to one of the assistants taking part in it.",
  "",
  "Answer with the assistant's exact name, or NOBODY.",
  "Answer with nothing else - no punctuation, no explanation.",
  "",
  "Say the name when the message continues the conversation with that assistant: a follow-up question, an answer to something it asked, a correction, or an instruction that only makes sense as a reply to it.",
  "Say NOBODY when people in the thread are talking to each other, thinking out loud, or reacting without asking for anything.",
  "When it is genuinely unclear, say NOBODY - a missed message is repaired by asking again, and a wrong wake interrupts people.",
].join("\n");

const truncate = (body: string): string =>
  body.length <= MAX_BODY ? body : `${body.slice(0, MAX_BODY)}…`;

const turnLine = (turn: ThreadTurn): string =>
  `${turn.authorName}: ${truncate(turn.body)}`;

export const buildAddressingPrompt = (input: {
  candidates: readonly AddressingCandidate[];
  message: ThreadTurn;
  thread: readonly ThreadTurn[];
}): string => {
  // The tail, not the head: what was said most recently is what the new message
  // is answering.
  const turns = input.thread.slice(-MAX_TURNS).map(turnLine);
  return [
    `Assistants in this thread: ${input.candidates.map((candidate) => candidate.name).join(", ")}`,
    "",
    "Thread so far:",
    ...turns,
    "",
    "New message:",
    turnLine(input.message),
    "",
    "Which assistant is this new message addressed to?",
  ].join("\n");
};

/**
 * The named agent, or `null` for "not for any of them" - which is also what an
 * answer we cannot make sense of means. The model is asked for a bare name and
 * usually gives one; a stray full stop or a wrapping quote should not cost a
 * wake, so the comparison is loose about everything except the name itself.
 */
export const parseAddressingAnswer = (
  answer: string | null,
  candidates: readonly AddressingCandidate[]
): AddressingCandidate | null => {
  if (!answer) {
    return null;
  }
  const cleaned = answer
    .trim()
    .replace(/^["'`]+|["'`.!]+$/g, "")
    .toLowerCase();
  if (!cleaned || cleaned === NOBODY.toLowerCase()) {
    return null;
  }
  return (
    candidates.find((candidate) => candidate.name.toLowerCase() === cleaned) ??
    null
  );
};
