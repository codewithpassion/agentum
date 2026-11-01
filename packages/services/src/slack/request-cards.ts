/** Pure request presentation. Input is already scrubbed by the request service,
 * as for protocol.approvalSummary; this module has no secret registry. */
import type { AnswerSurface } from "@repo/db/shared";
import {
  type ApprovalAnswer,
  type ApprovalDisplay,
  approvalAnswerSchema,
  type QuestionAnswer,
  type QuestionDisplay,
  questionAnswerSchema,
  type RequestOutcome,
  type TakeoverDisplay,
} from "@repo/protocol/requests";
import { z } from "zod";

interface PlainText {
  text: string;
  type: "plain_text";
}
interface Section {
  text: { type: "mrkdwn"; text: string };
  type: "section";
}
interface Button {
  action_id: string;
  style?: "danger";
  text: PlainText;
  type: "button";
  url?: string;
}
type Block = Section | { type: "actions"; elements: Button[] };
export interface RequestCard {
  blocks: Block[];
  text: string;
}
interface Base {
  agentName: string;
  /** Epoch milliseconds, matching request TTL constants. */
  expiresAt: number;
  requestId: string;
}
type ApprovalRequest = Base &
  Pick<ApprovalDisplay, "input" | "peerRun" | "summary">;
type QuestionRequest = Base & QuestionDisplay;
type TakeoverRequest = Base &
  Pick<TakeoverDisplay, "reason"> & {
    publicBaseUrl: string;
    runId: string;
  };
export type CardRequest = ApprovalRequest | QuestionRequest | TakeoverRequest;
const TRAILING_SLASHES = /\/+$/;
const INDEX = /^(0|[1-9]\d*)$/;
const isChoiceAction = (parts: string[]): boolean =>
  parts.length === 5 &&
  parts[2] === "choice" &&
  INDEX.test(parts[3] ?? "") &&
  INDEX.test(parts[4] ?? "");
const plain = (text: string): PlainText => ({ text, type: "plain_text" });
const escapeSlack = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const cut = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;
const section = (text: string): Section => ({
  text: { text: cut(text, 3000), type: "mrkdwn" },
  type: "section",
});
const button = (label: string, action_id: string): Button => ({
  action_id,
  text: plain(cut(label, 75)),
  type: "button",
});
const expiry = (expiresAt: number): Section =>
  section(
    `Expires <!date^${Math.floor(expiresAt / 1000)}^{date_short_pretty} at {time}|${new Date(expiresAt).toISOString()}>`
  );
const labels = {
  allow_once: "Allow once",
  always_allow: "Always allow",
  deny: "Deny",
} as const;

export const approvalCard = (request: ApprovalRequest): RequestCard => ({
  blocks: [
    section(
      `*${escapeSlack(request.agentName)}* requests approval\n${escapeSlack(request.summary)}`
    ),
    // Neutralise embedded fences before cutting; reserve all eight fence/newline characters.
    section(
      `\`\`\`\n${cut(escapeSlack(JSON.stringify(request.input, null, 2)).replaceAll("```", "` ` `"), 2992)}\n\`\`\``
    ),
    expiry(request.expiresAt),
    {
      elements: (Object.keys(labels) as (keyof typeof labels)[])
        // The rule Always allow saves applies to member runs, and a peer's run is gated by its connection, so it is not offered.
        .filter(
          (decision) =>
            !(request.peerRun === true && decision === "always_allow")
        )
        .map((decision) => ({
          ...button(
            labels[decision],
            `hm_req:${request.requestId}:${decision}`
          ),
          ...(decision === "deny" ? { style: "danger" as const } : {}),
        })),
      type: "actions",
    },
  ],
  text: escapeSlack(`${request.agentName}: ${request.summary}`),
});

export const questionCard = (request: QuestionRequest): RequestCard => ({
  blocks: [
    section(`*${escapeSlack(request.agentName)}* has a question`),
    ...request.questions.flatMap((q, index): Block[] => [
      section(
        `${q.header ? `*${escapeSlack(q.header)}*\n` : ""}${escapeSlack(q.question)}`
      ),
      {
        elements:
          // A choice button settles the whole request, so it is only safe when
          // there is nothing else to ask. Several questions go through the modal.
          q.choices?.length && !q.multiSelect && request.questions.length === 1
            ? q.choices.map((choice, i) =>
                button(
                  choice,
                  `hm_req:${request.requestId}:choice:${index}:${i}`
                )
              )
            : [button("Answer", `hm_req:${request.requestId}:modal`)],
        type: "actions",
      },
    ]),
    expiry(request.expiresAt),
  ],
  text: escapeSlack(
    `${request.agentName}: ${request.questions.map((q) => q.question).join("; ")}`
  ),
});

export const takeoverCard = (request: TakeoverRequest): RequestCard => ({
  blocks: [
    section(
      `*${escapeSlack(request.agentName)}* requests a take-over\n${escapeSlack(request.reason)}`
    ),
    expiry(request.expiresAt),
    {
      elements: [
        ...(request.publicBaseUrl
          ? [
              {
                ...button("Open screen", `hm_req:${request.requestId}:screen`),
                url: `${request.publicBaseUrl.replace(TRAILING_SLASHES, "")}/tasks/${encodeURIComponent(request.runId)}#computer`,
              },
            ]
          : []),
        {
          ...button("Cancel request", `hm_req:${request.requestId}:cancel`),
          style: "danger",
        },
      ],
      type: "actions",
    },
  ],
  text: escapeSlack(`${request.agentName}: ${request.reason}`),
});

export const requestCard = (request: CardRequest): RequestCard => {
  if ("reason" in request) {
    return takeoverCard(request);
  }
  return "questions" in request ? questionCard(request) : approvalCard(request);
};

interface Option {
  text: PlainText;
  value: string;
}
interface InputBlock {
  block_id: string;
  element:
    | { type: "plain_text_input"; action_id: "text"; multiline: true }
    | { type: "checkboxes"; action_id: "choices"; options: Option[] }
    | { type: "radio_buttons"; action_id: "choice"; options: Option[] };
  label: PlainText;
  optional: boolean;
  type: "input";
}
export interface RequestModal {
  blocks: InputBlock[];
  callback_id: string;
  close: PlainText;
  submit: PlainText;
  title: PlainText;
  type: "modal";
}

export const modalView = (request: QuestionRequest): RequestModal => ({
  blocks: request.questions.flatMap((q, index): InputBlock[] => {
    const options = (q.choices ?? []).map((choice, i) => ({
      text: plain(cut(choice, 75)),
      value: String(i),
    }));
    return [
      {
        block_id: `q${index}`,
        element: {
          action_id: "text",
          multiline: true,
          type: "plain_text_input",
        },
        label: plain(cut(q.question, 2000)),
        optional: Boolean(q.choices?.length),
        type: "input",
      },
      ...(q.choices?.length
        ? [
            {
              block_id: `c${index}`,
              element: q.multiSelect
                ? {
                    action_id: "choices" as const,
                    options,
                    type: "checkboxes" as const,
                  }
                : {
                    action_id: "choice" as const,
                    options,
                    type: "radio_buttons" as const,
                  },
              label: plain(
                q.multiSelect
                  ? "Choose any, or enter an answer above"
                  : "Choose one, or enter an answer above"
              ),
              optional: true,
              type: "input" as const,
            },
          ]
        : []),
    ];
  }),
  callback_id: `hm_req_modal:${request.requestId}`,
  close: plain("Cancel"),
  submit: plain("Submit"),
  title: plain("Answer questions"),
  type: "modal",
});

export const settledCard = (
  request: CardRequest,
  {
    by,
    via,
    outcome,
  }: { by?: string; via?: AnswerSurface; outcome: RequestOutcome }
): RequestCard => {
  let status: string;
  if (outcome.status === "expired") {
    status = "Expired, nobody answered";
  } else if (outcome.status === "cancelled") {
    status = "Cancelled";
  } else {
    const { answer } = outcome;
    let action = "Answered";
    if ("reason" in request) {
      action = "Handed back";
    } else if ("decision" in answer) {
      action = {
        allow_once: "Allowed once",
        always_allow: "Always allowed",
        deny: "Denied",
      }[answer.decision];
    }
    status = `${action}${by ? ` by ${by}` : ""}${via ? ` on ${via === "web" ? "the web" : "Slack"}` : ""}`;
  }
  const card = requestCard(request);
  return {
    blocks: [
      ...card.blocks.filter((block) => block.type !== "actions"),
      section(escapeSlack(status)),
    ],
    text: `${card.text} — ${status}`,
  };
};

const identitySchema = z.object({
  api_app_id: z.string().min(1),
  team: z.object({ id: z.string().min(1) }),
  user: z.object({ id: z.string().min(1) }),
});
const actionSchema = z.object({
  actions: z.array(z.object({ action_id: z.string() })).length(1),
  trigger_id: z.string().optional(),
  type: z.literal("block_actions"),
});
const submissionSchema = z.object({
  type: z.literal("view_submission"),
  view: z.object({
    callback_id: z.string(),
    state: z.object({
      values: z.record(z.string(), z.record(z.string(), z.unknown())),
    }),
  }),
});
const textState = z.object({
  type: z.literal("plain_text_input"),
  value: z.string().nullable(),
});
const choicesState = z.object({
  selected_options: z.array(z.object({ value: z.string() })),
  type: z.literal("checkboxes"),
});
const choiceState = z.object({
  selected_option: z.object({ value: z.string() }).nullable(),
  type: z.literal("radio_buttons"),
});

export type Questions = QuestionDisplay["questions"];
interface Identity {
  appId: string;
  teamId: string;
  userId: string;
}
type ParsedAnswer =
  | { answer: ApprovalAnswer | QuestionAnswer; cancel?: never }
  | { cancel: true; answer?: never };

export type InteractionResult =
  | ({
      ok: true;
      requestId: string;
    } & Identity &
      ParsedAnswer)
  | ({
      ok: false;
      reason: "modal_required";
      requestId: string;
      triggerId: string | undefined;
    } & Identity)
  | {
      ok: false;
      reason: "questions_required";
      requestId: string;
    }
  | {
      ok: false;
      reason: "foreign" | "invalid";
      requestId?: string;
    };

const optionIndex = (value: string, count: number): number => {
  const index = INDEX.test(value) ? Number(value) : -1;
  if (index < 0 || index >= count) {
    throw new Error("Unknown choice");
  }
  return index;
};

const modalAnswer = (
  view: z.infer<typeof submissionSchema>["view"],
  questions: Questions
): QuestionAnswer => {
  const answers = questions.map((q, i): [string, string] => {
    const text = textState.parse(view.state.values[`q${i}`]?.text).value;
    // Free text is always permitted by V1.1, and takes precedence over choices.
    let answer = text ?? "";
    if (!answer && q.choices?.length) {
      const { choices } = q;
      const picked = q.multiSelect
        ? choicesState
            .parse(view.state.values[`c${i}`]?.choices)
            .selected_options.map((option) => option.value)
        : [
            choiceState.parse(view.state.values[`c${i}`]?.choice)
              .selected_option?.value,
          ].filter((value): value is string => value !== undefined);
      answer = picked
        .map((value) => choices[optionIndex(value, choices.length)])
        .join(", ");
    }
    if (!answer) {
      throw new Error("Empty answer");
    }
    return [q.question, answer];
  });
  return questionAnswerSchema.parse({ answers: Object.fromEntries(answers) });
};

type Parsed =
  | ({ requestId: string } & ParsedAnswer)
  | Exclude<InteractionResult, { ok: true }>;

const parseAction = (
  action: z.infer<typeof actionSchema>,
  payload: unknown,
  questions: Questions | undefined
): Parsed => {
  const [clicked] = action.actions;
  const parts = (clicked?.action_id ?? "").split(":");
  if (parts[0] !== "hm_req") {
    return { ok: false, reason: clicked ? "foreign" : "invalid" };
  }
  const requestId = z.string().min(1).parse(parts[1]);
  if (parts.length === 3 && parts[2] === "modal") {
    const identity = identitySchema.parse(payload);
    return {
      appId: identity.api_app_id,
      ok: false,
      reason: "modal_required",
      requestId,
      teamId: identity.team.id,
      triggerId: action.trigger_id,
      userId: identity.user.id,
    };
  }
  if (isChoiceAction(parts)) {
    if (questions === undefined) {
      return { ok: false, reason: "questions_required", requestId };
    }
    const question = questions[Number(parts[3])];
    const choice = question?.choices?.[Number(parts[4])];
    if (question === undefined || choice === undefined) {
      return { ok: false, reason: "invalid", requestId };
    }
    return {
      answer: questionAnswerSchema.parse({
        answers: { [question.question]: choice },
      }),
      requestId,
    };
  }
  if (parts.length !== 3) {
    return { ok: false, reason: "invalid" };
  }
  if (parts[2] === "cancel") {
    return { cancel: true, requestId };
  }
  return {
    answer: approvalAnswerSchema.parse({ decision: parts[2] }),
    requestId,
  };
};

const parseSubmission = (
  view: z.infer<typeof submissionSchema>["view"],
  questions: Questions | undefined
): Parsed => {
  const parts = view.callback_id.split(":");
  if (parts[0] !== "hm_req_modal") {
    return { ok: false, reason: "foreign" };
  }
  if (parts.length !== 2) {
    return { ok: false, reason: "invalid" };
  }
  const requestId = z.string().min(1).parse(parts[1]);
  if (questions === undefined) {
    return { ok: false, reason: "questions_required", requestId };
  }
  return { answer: modalAnswer(view, questions), requestId };
};

/**
 * Parsing only: the caller must verify Slack's signature, app/team ownership,
 * request state and answer authorization before accepting these untrusted values.
 * Choice buttons and modal submissions carry indices, not text, because Slack caps
 * button values and private metadata. The caller loads the request's questions
 * from its stored display and parses again with them; without them those two
 * interactions answer `questions_required`.
 */
export const parseInteraction = (
  payload: unknown,
  questions?: Questions
): InteractionResult => {
  try {
    const action = actionSchema.safeParse(payload);
    const submission = submissionSchema.safeParse(payload);
    let parsed: Parsed = { ok: false, reason: "invalid" };
    if (action.success) {
      parsed = parseAction(action.data, payload, questions);
    } else if (submission.success) {
      parsed = parseSubmission(submission.data.view, questions);
    }
    if ("ok" in parsed) {
      return parsed;
    }
    const identity = identitySchema.parse(payload);
    return {
      ...(parsed.cancel
        ? { cancel: true as const }
        : { answer: parsed.answer }),
      appId: identity.api_app_id,
      ok: true,
      requestId: parsed.requestId,
      teamId: identity.team.id,
      userId: identity.user.id,
    };
  } catch {
    return { ok: false, reason: "invalid" };
  }
};
