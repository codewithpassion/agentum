import type { QuestionView } from "#/modules/questions/view";
import { bodyToSlackText } from "./text";

/**
 * A question card as Slack draws it: Block Kit for the same question the web UI
 * renders from `MessageView.question`. Pure - the caller supplies the view and
 * the deep link, and gets blocks back.
 *
 * The click comes back to `/interactive` carrying the button's `value`, which is
 * why the identity of a question travels in the payload rather than in the
 * message `ts`: a card can be edited, re-posted or threaded, and the answer must
 * still name the question it answers.
 *
 * Slack's limits, and which ones bite:
 * - section `mrkdwn` is capped at 3000 characters and a prompt at 4000, so the
 *   prompt is truncated here;
 * - a button's `plain_text` is capped at 75 and an option at 120, so the *label*
 *   is truncated - the full option stays in `value`, which is what the answer is
 *   validated against;
 * - an actions block holds up to 25 elements and a question at most 10 options
 *   (`MAX_OPTIONS`), so the buttons never need splitting.
 */

export type SlackBlock = Record<string, unknown>;

const SECTION_TEXT_MAX = 3000;
const BUTTON_TEXT_MAX = 75;
const FALLBACK_TEXT_MAX = 300;
const ELLIPSIS = "…";

const TRAILING_SLASHES = /\/+$/;

const PERMISSION_HEADER = "⚠️ *Permission request*";
const ANSWERED_MARK = "✅";
const EXPIRED_MARK = "⌛";

/** The action prefix, which is also what tells our buttons from anyone's. */
const QUESTION_ACTION = "question";

export interface QuestionAction {
  option: string;
  questionId: string;
}

const truncate = (value: string, max: number): string =>
  value.length > max
    ? `${value.slice(0, max - ELLIPSIS.length)}${ELLIPSIS}`
    : value;

/** Unique within the message, which Slack requires of every `action_id`. */
const actionId = (questionId: string, index: number): string =>
  `${QUESTION_ACTION}:${questionId}:${index}`;

export const encodeQuestionAction = (action: QuestionAction): string =>
  JSON.stringify({ option: action.option, questionId: action.questionId });

/**
 * `null` for anything that is not one of our option buttons - including the
 * "Answer in Agentum" link button, which Slack also reports as a `block_actions`
 * click even though it carries no answer.
 */
export const parseQuestionAction = (
  value: string | null | undefined
): QuestionAction | null => {
  if (!value) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const { option, questionId } = parsed as Record<string, unknown>;
  if (typeof option !== "string" || typeof questionId !== "string") {
    return null;
  }
  return option && questionId ? { option, questionId } : null;
};

const promptText = (question: QuestionView): string => {
  const prompt = bodyToSlackText(question.prompt);
  const body =
    question.kind === "permission" ? `${PERMISSION_HEADER}\n${prompt}` : prompt;
  return truncate(body, SECTION_TEXT_MAX);
};

const section = (text: string): SlackBlock => ({
  text: { text, type: "mrkdwn" },
  type: "section",
});

const context = (text: string): SlackBlock => ({
  elements: [{ text, type: "mrkdwn" }],
  type: "context",
});

/** Approve is the safe-looking button and Deny the alarming one - but only on a
 * permission request, where the choice is a gate rather than a preference. */
const buttonStyle = (
  question: QuestionView,
  option: string
): "danger" | "primary" | undefined => {
  if (question.kind !== "permission") {
    return;
  }
  const normalized = option.trim().toLowerCase();
  if (normalized === "approve") {
    return "primary";
  }
  return normalized === "deny" ? "danger" : undefined;
};

const optionButton = (
  question: QuestionView,
  option: string,
  index: number
): SlackBlock => {
  const style = buttonStyle(question, option);
  return {
    action_id: actionId(question.id, index),
    text: {
      emoji: true,
      text: truncate(option, BUTTON_TEXT_MAX),
      type: "plain_text",
    },
    type: "button",
    value: encodeQuestionAction({ option, questionId: question.id }),
    ...(style ? { style } : {}),
  };
};

/**
 * Slack has no free-text answer in a message - a modal would need a live
 * interaction and a reply cannot be told from any other reply - so a question
 * without options is answered in the app, and the card says so.
 */
const freeTextBlocks = (link: string | null): SlackBlock[] => {
  if (!link) {
    return [context("_Open Agentum to answer this one._")];
  }
  return [
    {
      elements: [
        {
          action_id: `${QUESTION_ACTION}:open`,
          text: { emoji: true, text: "Answer in Agentum", type: "plain_text" },
          type: "button",
          url: link,
        },
      ],
      type: "actions",
    },
  ];
};

export interface QuestionCardOptions {
  /** Deep link to the card in the web app; null when no public URL is known. */
  link?: string | null;
}

/** The pending card: the prompt, and a button per option. */
export const questionBlocks = (
  question: QuestionView,
  options: QuestionCardOptions = {}
): SlackBlock[] => {
  const blocks: SlackBlock[] = [section(promptText(question))];

  if (question.options && question.options.length > 0) {
    blocks.push({
      block_id: `${QUESTION_ACTION}:${question.id}`,
      elements: question.options.map((option, index) =>
        optionButton(question, option, index)
      ),
      type: "actions",
    });
    return blocks;
  }

  blocks.push(...freeTextBlocks(options.link ?? null));
  return blocks;
};

const resolutionLine = (question: QuestionView): string => {
  if (question.status === "expired") {
    return `${EXPIRED_MARK} _Expired - nobody answered in time._`;
  }
  const who = bodyToSlackText(
    question.answeredBy ? question.answeredBy.name : "somebody"
  );
  const answer = bodyToSlackText(question.answer ?? "");
  return `${ANSWERED_MARK} *Answered by ${who}* - ${answer}`;
};

/**
 * The resolved card: the same prompt with the buttons gone, so a question that
 * was answered anywhere cannot be answered again from Slack.
 */
export const resolvedQuestionBlocks = (
  question: QuestionView
): SlackBlock[] => [
  section(promptText(question)),
  context(resolutionLine(question)),
];

/**
 * The `text` that rides along with every blocks payload: it is what Slack shows
 * in notifications and reads out to screen readers, and what survives if the
 * blocks ever fail to render.
 */
export const questionFallbackText = (question: QuestionView): string => {
  const prompt = truncate(bodyToSlackText(question.prompt), FALLBACK_TEXT_MAX);
  if (question.status === "pending") {
    return question.kind === "permission"
      ? `Permission request: ${prompt}`
      : prompt;
  }
  return `${prompt}\n${resolutionLine(question)}`;
};

/** Where the question card lives in the web app, for the free-text button. */
export const questionWebLink = (
  appUrl: string | null | undefined,
  workspaceSlug: string,
  question: { channelId: string; messageId: string }
): string | null => {
  if (!appUrl) {
    return null;
  }
  const base = appUrl.replace(TRAILING_SLASHES, "");
  const params = new URLSearchParams({
    channel: question.channelId,
    message: question.messageId,
  });
  return `${base}/w/${workspaceSlug}?${params.toString()}`;
};
