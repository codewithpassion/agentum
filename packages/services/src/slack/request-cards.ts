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
  questionDisplaySchema,
  type RequestOutcome,
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
  value?: string;
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
type ApprovalRequest = Base & Pick<ApprovalDisplay, "input" | "summary">;
type QuestionRequest = Base & QuestionDisplay;
export type CardRequest = ApprovalRequest | QuestionRequest;
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
const button = (label: string, action_id: string, value?: string): Button => ({
  action_id,
  text: plain(cut(label, 75)),
  type: "button",
  ...(value === undefined ? {} : { value }),
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
      elements: (Object.keys(labels) as (keyof typeof labels)[]).map(
        (decision) => ({
          ...button(
            labels[decision],
            `hm_req:${request.requestId}:${decision}`
          ),
          ...(decision === "deny" ? { style: "danger" as const } : {}),
        })
      ),
      type: "actions",
    },
  ],
  text: `${request.agentName}: ${request.summary}`,
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
          q.choices?.length && !q.multiSelect
            ? q.choices.map((choice, i) =>
                button(
                  choice,
                  `hm_req:${request.requestId}:choice:${index}:${i}`,
                  JSON.stringify({ choice, question: q.question })
                )
              )
            : [button("Answer", `hm_req:${request.requestId}:modal`)],
        type: "actions",
      },
    ]),
    expiry(request.expiresAt),
  ],
  text: `${request.agentName}: ${request.questions.map((q) => q.question).join("; ")}`,
});

interface Option {
  text: PlainText;
  value: string;
}
interface InputBlock {
  block_id: string;
  element:
    | { type: "plain_text_input"; action_id: "text"; multiline: true }
    | { type: "checkboxes"; action_id: "choices"; options: Option[] };
  label: PlainText;
  optional: boolean;
  type: "input";
}
export interface RequestModal {
  blocks: InputBlock[];
  callback_id: string;
  close: PlainText;
  private_metadata: string;
  submit: PlainText;
  title: PlainText;
  type: "modal";
}

export const modalView = (request: QuestionRequest): RequestModal => ({
  blocks: request.questions.flatMap((q, index): InputBlock[] => [
    {
      block_id: `q${index}`,
      element: { action_id: "text", multiline: true, type: "plain_text_input" },
      label: plain(cut(q.question, 2000)),
      optional: Boolean(q.multiSelect && q.choices?.length),
      type: "input",
    },
    ...(q.multiSelect && q.choices?.length
      ? [
          {
            block_id: `c${index}`,
            element: {
              action_id: "choices" as const,
              options: q.choices.map((choice, i) => ({
                text: plain(cut(choice, 75)),
                value: String(i),
              })),
              type: "checkboxes" as const,
            },
            label: plain("Choose any, or enter an answer above"),
            optional: true,
            type: "input" as const,
          },
        ]
      : []),
  ]),
  callback_id: `hm_req_modal:${request.requestId}`,
  close: plain("Cancel"),
  // The modal answers the entire request. Indices keep Slack IDs short while
  // metadata preserves the original question text used as the answer key.
  private_metadata: JSON.stringify({ questions: request.questions }),
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
    const action =
      "decision" in answer
        ? {
            allow_once: "Allowed once",
            always_allow: "Always allowed",
            deny: "Denied",
          }[answer.decision]
        : "Answered";
    status = `${action}${by ? ` by ${by}` : ""}${via ? ` on ${via === "web" ? "the web" : "Slack"}` : ""}`;
  }
  const card =
    "questions" in request ? questionCard(request) : approvalCard(request);
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
  actions: z
    .array(z.object({ action_id: z.string(), value: z.string().optional() }))
    .length(1),
  type: z.literal("block_actions"),
});
const submissionSchema = z.object({
  type: z.literal("view_submission"),
  view: z.object({
    callback_id: z.string(),
    private_metadata: z.string(),
    state: z.object({
      values: z.record(z.string(), z.record(z.string(), z.unknown())),
    }),
  }),
});
const textState = z.object({
  type: z.literal("plain_text_input"),
  value: z.string().nullable(),
});
const choiceState = z.object({
  selected_options: z.array(z.object({ value: z.string() })),
  type: z.literal("checkboxes"),
});
const choiceValue = z.object({
  choice: z.string().min(1),
  question: z.string().min(1),
});
export type InteractionResult =
  | {
      ok: true;
      requestId: string;
      userId: string;
      teamId: string;
      appId: string;
      answer: ApprovalAnswer | QuestionAnswer;
    }
  | {
      ok: false;
      reason: "foreign" | "invalid" | "modal_required";
      requestId?: string;
    };

const modalAnswer = (
  view: z.infer<typeof submissionSchema>["view"]
): QuestionAnswer => {
  const { questions } = questionDisplaySchema.parse(
    JSON.parse(view.private_metadata)
  );
  const answers = questions.map((q, i): [string, string] => {
    const text = textState.parse(view.state.values[`q${i}`]?.text).value;
    // Free text is always permitted by V1.1, and takes precedence over choices.
    if (text) {
      return [q.question, text];
    }
    if (q.multiSelect && q.choices?.length) {
      const selected = choiceState.parse(view.state.values[`c${i}`]?.choices);
      return [
        q.question,
        selected.selected_options
          .map((option) => {
            if (!INDEX.test(option.value)) {
              throw new Error("Invalid choice");
            }
            const choice = q.choices?.[Number(option.value)];
            if (choice === undefined) {
              throw new Error("Unknown choice");
            }
            return choice;
          })
          .join(", "),
      ];
    }
    return [q.question, text ?? ""];
  });
  return questionAnswerSchema.parse({ answers: Object.fromEntries(answers) });
};

/** Parsing only: the caller must verify Slack's signature, app/team ownership,
 * request state and answer authorization before accepting these untrusted values. */
export const parseInteraction = (payload: unknown): InteractionResult => {
  try {
    let requestId: string;
    let answer: ApprovalAnswer | QuestionAnswer;
    const action = actionSchema.safeParse(payload);
    if (action.success) {
      const [clicked] = action.data.actions;
      if (!clicked) {
        return { ok: false, reason: "invalid" };
      }
      const parts = clicked.action_id.split(":");
      if (parts[0] !== "hm_req") {
        return { ok: false, reason: "foreign" };
      }
      requestId = z.string().min(1).parse(parts[1]);
      if (parts.length === 3 && parts[2] === "modal") {
        identitySchema.parse(payload);
        return { ok: false, reason: "modal_required", requestId };
      }
      if (isChoiceAction(parts)) {
        const value = choiceValue.parse(JSON.parse(clicked.value ?? ""));
        answer = questionAnswerSchema.parse({
          answers: { [value.question]: value.choice },
        });
      } else {
        if (parts.length !== 3) {
          return { ok: false, reason: "invalid" };
        }
        answer = approvalAnswerSchema.parse({ decision: parts[2] });
      }
    } else {
      const submission = submissionSchema.safeParse(payload);
      if (!submission.success) {
        return { ok: false, reason: "invalid" };
      }
      const parts = submission.data.view.callback_id.split(":");
      if (parts[0] !== "hm_req_modal") {
        return { ok: false, reason: "foreign" };
      }
      if (parts.length !== 2) {
        return { ok: false, reason: "invalid" };
      }
      requestId = z.string().min(1).parse(parts[1]);
      answer = modalAnswer(submission.data.view);
    }
    const identity = identitySchema.parse(payload);
    return {
      answer,
      appId: identity.api_app_id,
      ok: true,
      requestId,
      teamId: identity.team.id,
      userId: identity.user.id,
    };
  } catch {
    return { ok: false, reason: "invalid" };
  }
};
