import { describe, expect, test } from "bun:test";
import type { QuestionView } from "#/modules/questions/view";
import {
  encodeQuestionAction,
  parseQuestionAction,
  questionBlocks,
  questionFallbackText,
  questionWebLink,
  resolvedQuestionBlocks,
} from "./blocks";

/**
 * The Slack card, against Slack's own limits: a prompt is allowed to be longer
 * than a section, an option longer than a button label, and neither may reach
 * Slack in a shape it refuses.
 */

const SECTION_TEXT_MAX = 3000;
const BUTTON_TEXT_MAX = 75;

const question = (overrides: Partial<QuestionView> = {}): QuestionView => ({
  agentId: "agent-1",
  answer: null,
  answeredAt: null,
  answeredBy: null,
  answeredVia: null,
  channelId: "channel-1",
  createdAt: 0,
  expiresAt: null,
  id: "question-1",
  kind: "question",
  messageId: "message-1",
  options: ["Postgres", "SQLite"],
  prompt: "Which database?",
  status: "pending",
  ...overrides,
});

interface Button {
  action_id: string;
  style?: string;
  text: { text: string };
  url?: string;
  value?: string;
}

const buttons = (blocks: unknown[]): Button[] =>
  (blocks[1] as { elements?: Button[] }).elements ?? [];

const sectionText = (blocks: unknown[]): string =>
  (blocks[0] as { text: { text: string } }).text.text;

describe("questionBlocks", () => {
  test("draws a button per option, each carrying the question and the choice", () => {
    const blocks = questionBlocks(question());

    expect(sectionText(blocks)).toBe("Which database?");
    expect(buttons(blocks).map((button) => button.text.text)).toEqual([
      "Postgres",
      "SQLite",
    ]);
    expect(parseQuestionAction(buttons(blocks)[1]?.value)).toEqual({
      option: "SQLite",
      questionId: "question-1",
    });
  });

  test("gives every button its own action id, which Slack requires", () => {
    const ids = buttons(questionBlocks(question())).map(
      (button) => button.action_id
    );

    expect(new Set(ids).size).toBe(ids.length);
  });

  test("a permission request is headed and colour-coded", () => {
    const blocks = questionBlocks(
      question({ kind: "permission", options: ["Approve", "Deny"] })
    );

    expect(sectionText(blocks)).toContain("Permission request");
    expect(buttons(blocks).map((button) => button.style)).toEqual([
      "primary",
      "danger",
    ]);
  });

  test("an ordinary question's buttons are unstyled", () => {
    expect(
      buttons(questionBlocks(question())).every(
        (button) => button.style === undefined
      )
    ).toBe(true);
  });

  test("all ten options a question may carry fit one actions block", () => {
    // `MAX_OPTIONS` is 10 and Slack allows 25 elements, so the buttons never
    // need splitting - this is the pin on that headroom.
    const options = Array.from({ length: 10 }, (_, index) => `Option ${index}`);

    expect(buttons(questionBlocks(question({ options })))).toHaveLength(10);
  });

  test("truncates a button label without touching the answer it sends", () => {
    const option = "y".repeat(120);

    const rendered = buttons(questionBlocks(question({ options: [option] })));

    expect(rendered.map((button) => button.text.text.length)).toEqual([
      BUTTON_TEXT_MAX,
    ]);
    // The full option travels in `value`: the answer is validated against the
    // stored options, and a truncated one would be refused.
    expect(
      rendered.map((button) => parseQuestionAction(button.value)?.option)
    ).toEqual([option]);
  });

  test("truncates a prompt that is longer than a section may be", () => {
    const blocks = questionBlocks(question({ prompt: "p".repeat(4000) }));

    expect(sectionText(blocks).length).toBe(SECTION_TEXT_MAX);
  });

  test("escapes Slack's markup so a prompt cannot become one", () => {
    const blocks = questionBlocks(
      question({ prompt: "Delete <https://example.com|everything> & retry?" })
    );

    expect(sectionText(blocks)).toBe(
      "Delete &lt;https://example.com|everything&gt; &amp; retry?"
    );
  });

  test("a free-text question links to the app, since Slack cannot type one", () => {
    const blocks = questionBlocks(question({ options: null }), {
      link: "https://agentum.example.com/w/alpha",
    });

    expect(buttons(blocks)[0]?.url).toBe("https://agentum.example.com/w/alpha");
    expect(buttons(blocks)[0]?.value).toBeUndefined();
  });

  test("falls back to a note when there is no public URL to link to", () => {
    const blocks = questionBlocks(question({ options: null }), { link: null });

    expect(blocks).toHaveLength(2);
    expect(JSON.stringify(blocks[1])).toContain("Open Agentum");
  });
});

describe("resolvedQuestionBlocks", () => {
  test("replaces the buttons with who answered and what they chose", () => {
    const blocks = resolvedQuestionBlocks(
      question({
        answer: "Postgres",
        answeredBy: { id: "slack:U1", name: "Ada" },
        answeredVia: "slack",
        status: "answered",
      })
    );

    expect(blocks).toHaveLength(2);
    expect(JSON.stringify(blocks[1])).toContain("Answered by Ada");
    expect(JSON.stringify(blocks[1])).toContain("Postgres");
  });

  test("names the expiry when nobody answered", () => {
    const blocks = resolvedQuestionBlocks(question({ status: "expired" }));

    expect(JSON.stringify(blocks[1])).toContain("Expired");
  });

  test("an answer of unknown authorship still reads as answered", () => {
    const blocks = resolvedQuestionBlocks(
      question({ answer: "SQLite", status: "answered" })
    );

    expect(JSON.stringify(blocks[1])).toContain("Answered by somebody");
  });
});

describe("questionFallbackText", () => {
  test("is the prompt while the question waits", () => {
    expect(questionFallbackText(question())).toBe("Which database?");
  });

  test("names a permission request, which reads differently in a notification", () => {
    expect(questionFallbackText(question({ kind: "permission" }))).toBe(
      "Permission request: Which database?"
    );
  });

  test("carries the resolution once there is one", () => {
    expect(
      questionFallbackText(
        question({
          answer: "Postgres",
          answeredBy: { id: "member-1", name: "Ada" },
          status: "answered",
        })
      )
    ).toContain("Answered by Ada");
  });
});

describe("parseQuestionAction", () => {
  test("round-trips what a button carries", () => {
    const action = { option: "Approve", questionId: "question-1" };

    expect(parseQuestionAction(encodeQuestionAction(action))).toEqual(action);
  });

  test("refuses anything that is not one of our buttons", () => {
    // A link button, a Slack-native menu, a hand-rolled payload: none of these
    // may become an answer.
    expect(parseQuestionAction(undefined)).toBeNull();
    expect(parseQuestionAction("")).toBeNull();
    expect(parseQuestionAction("not json")).toBeNull();
    expect(parseQuestionAction('{"option":"Approve"}')).toBeNull();
    expect(parseQuestionAction('{"option":1,"questionId":"q"}')).toBeNull();
    expect(parseQuestionAction("[]")).toBeNull();
  });
});

describe("questionWebLink", () => {
  test("points at the card in its channel", () => {
    expect(
      questionWebLink("https://agentum.example.com/", "alpha", {
        channelId: "channel-1",
        messageId: "message-1",
      })
    ).toBe(
      "https://agentum.example.com/w/alpha?channel=channel-1&message=message-1"
    );
  });

  test("is null without a public URL, and the card drops the button", () => {
    expect(
      questionWebLink(undefined, "alpha", {
        channelId: "channel-1",
        messageId: "message-1",
      })
    ).toBeNull();
  });
});
