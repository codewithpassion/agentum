import { z } from "zod";
import type { Db } from "#/db/client";
import type { AgentQuestion } from "#/modules/questions/schema";
import {
  type AnswerResult,
  answerQuestion,
  getQuestion,
  resolveIfExpired,
} from "#/modules/questions/service";
import { toQuestionViews } from "#/modules/questions/view";
import { getWorkspaceById } from "#/modules/workspaces/service";
import { listBridgesForChannel } from "../bridges";
import type { SlackApp } from "../schema";
import { slackClientForApp } from "./adapter";
import {
  parseQuestionAction,
  questionFallbackText,
  resolvedQuestionBlocks,
} from "./blocks";
import { postSlackResponse } from "./client";
import { SLACK_CONNECTOR } from "./config";
import { resolveSlackUserNames } from "./users";

/**
 * What happens when somebody presses a button on a mirrored question card.
 *
 * The click is answered through the *same* `answerQuestion` the web card calls -
 * there is one answer path, so the race, the wake and the broadcast behave
 * identically whichever surface won. All this file adds is who clicked
 * (`slack:U…`), whether they were allowed to (the ownership filter), and what
 * the card should say afterwards.
 */

const slackActionSchema = z.object({
  action_id: z.string().optional(),
  value: z.string().optional(),
});

export const slackInteractionSchema = z.object({
  actions: z.array(slackActionSchema).optional(),
  channel: z.object({ id: z.string().optional() }).optional(),
  /** One-shot URL for rewriting the message the button sat in. */
  response_url: z.string().optional(),
  type: z.string(),
  user: z.object({ id: z.string().optional() }).optional(),
});

export type SlackInteraction = z.infer<typeof slackInteractionSchema>;

/**
 * Slack posts interactions as `application/x-www-form-urlencoded` with the JSON
 * in a single `payload` field - the one place its webhooks are not JSON. The raw
 * body is signed either way, so this runs *after* verification.
 */
export const parseSlackInteraction = (
  rawBody: string
): SlackInteraction | null => {
  const payload = new URLSearchParams(rawBody).get("payload");
  if (!payload) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  const result = slackInteractionSchema.safeParse(parsed);
  return result.success ? result.data : null;
};

const SLACK_AUTHOR_PREFIX = `${SLACK_CONNECTOR}:`;

/**
 * The row behind an answer attempt: the one this click wrote, or the one that
 * beat it. `null` only when the option itself was refused, which is a card Slack
 * cannot redraw from - the question is still pending.
 */
const resolvedRow = (result: AnswerResult): AgentQuestion | null => {
  if (result.ok) {
    return result.question;
  }
  return result.reason === "already-resolved" ? result.question : null;
};

/**
 * The click that answers a question, from the row it names to the card that
 * replaces it. Every dead end here returns quietly: Slack has already had its
 * 200, and the person who clicked a button on somebody else's app - or on a
 * question that has since gone - is told by the card, not by an error.
 */
export const handleQuestionInteraction = async (
  db: Db,
  env: Env,
  app: SlackApp,
  interaction: SlackInteraction
): Promise<void> => {
  const userId = interaction.user?.id;
  const action = interaction.actions?.find((candidate) =>
    parseQuestionAction(candidate.value)
  );
  const clicked = parseQuestionAction(action?.value);
  // Not one of our option buttons: the "Answer in Agentum" link reports its
  // click too, and carries nothing to answer with.
  if (!(clicked && userId)) {
    return;
  }

  const existing = await getQuestion(db, app.workspaceId, clicked.questionId);
  if (!existing) {
    return;
  }

  // The ownership filter, as on the events route: this app may only act on the
  // questions of a channel bridged through itself. Two bots in one Slack channel
  // both see the card; only one of them owns it.
  const bridges = await listBridgesForChannel(db, existing.channelId);
  const bridge = bridges.find(
    (candidate) =>
      candidate.connector === SLACK_CONNECTOR &&
      candidate.status === "active" &&
      candidate.slackAppId === app.id
  );
  if (!bridge) {
    return;
  }

  const workspace = await getWorkspaceById(db, existing.workspaceId);
  if (!workspace) {
    return;
  }
  const scope = { id: workspace.id, slug: workspace.slug };

  // Lazy expiry first, exactly as the web route does it: an answer must never
  // land on a question whose time has gone.
  const question = await resolveIfExpired(db, env, scope, existing);

  // The display name is cached on the way past, so the view that renders
  // `answeredBy` has a name rather than a `U…` for every later read.
  const client = await slackClientForApp(env, app);
  await resolveSlackUserNames(db, client, [userId]);

  const answerer = `${SLACK_AUTHOR_PREFIX}${userId}`;
  const result = await answerQuestion(db, env, scope, question, {
    answer: clicked.option,
    by: {
      authorId: answerer,
      authorType: "external",
      id: answerer,
      via: "slack",
    },
  });

  if (!interaction.response_url) {
    return;
  }

  // Either the answer that won or the one that got there first - the card is
  // rewritten from whatever the row now says, so a losing click shows the
  // winner rather than an error.
  const row = resolvedRow(result);
  if (!row) {
    await postSlackResponse(interaction.response_url, {
      replaceOriginal: false,
      responseType: "ephemeral",
      text: "That choice is no longer one of this question's options.",
    });
    return;
  }

  const [view] = await toQuestionViews(db, scope.id, [row]);
  if (!view) {
    return;
  }
  await postSlackResponse(interaction.response_url, {
    blocks: resolvedQuestionBlocks(view),
    replaceOriginal: true,
    text: questionFallbackText(view),
  });
};
