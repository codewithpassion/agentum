// A scripted model for local checks. `PiRun` loads this module in dev builds
// only, behind `import.meta.env.DEV`, so a deployed Worker cannot reach it. An
// agent whose model is `faux` answers from its prompt alone, with no API key.
import {
  type AssistantMessage,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type JsonObject,
  type Message,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { GATED_TOOL } from "./pi-run-dev-tools.ts";

export const FAUX_MODEL = "faux";

const RESPONSES = 1000;
const TOKENS_PER_SECOND = 200;
const SLOW_REPEATS = 4000;
const BASH_PREFIX = "bash ";
const SLOW_BASH_PREFIX = "slow-bash ";
const FAIL_PREFIX = "fail ";
const CALL_PREFIX = "call ";
const ASK_PREFIX = "ask ";
const GATED_PROMPT = "gated";
const SAY_PREFIX = "say ";
const TURN_PREFIX = '{"harbourmaster_turn"';

/** The arguments of a `call` prompt: a JSON object, or `{}` when it is missing or not one. */
const argsOf = (json: string): JsonObject => {
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : {};
  } catch {
    return {};
  }
};

/**
 * What the sender typed. A message from another agent arrives wrapped in a
 * `harbourmaster_turn` envelope (a peer over A2A, for one), and the commands
 * below mean the text inside it. Anything else is the prompt as it is.
 */
const typedText = (prompt: string): string => {
  if (!prompt.startsWith(TURN_PREFIX)) {
    return prompt;
  }
  try {
    const turn: unknown = JSON.parse(prompt);
    const text = (turn as { harbourmaster_turn?: { text?: unknown } })
      .harbourmaster_turn?.text;
    return typeof text === "string" ? text : prompt;
  } catch {
    return prompt;
  }
};

const textOf = (content: Message["content"] | undefined): string => {
  if (content === undefined) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((part) =>
      "text" in part && typeof part.text === "string" ? part.text : ""
    )
    .join("");
};

/**
 * `echo`: repeats the prompt. `fail <text>`: the model errors with that text.
 * `slow`: an answer that takes about half a minute, to stop halfway. `bash <script>`: calls
 * the platform's library `bash` tool, then repeats what it said. `slow-bash <script>`: the
 * slow answer and then the same tool call in one message, so a run is still streaming when a
 * test stops the server in the middle. `call <tool> <json>`: calls the Pi tool named `<tool>`
 * with the JSON object as its arguments (`{}` when the JSON is missing or invalid), then
 * repeats what it said. `ask <question>`: calls the Pi tool `ask_user` with the question, then
 * repeats what it said. `gated`: calls the dev tool `dev_gated`, then repeats what it said.
 * `say <text>`: answers with exactly that text. The commands read the text inside a
 * `harbourmaster_turn` envelope, so they work for a message another agent sent.
 */
export const fauxScript = (context: TranscriptContext): AssistantMessage => {
  const last = context.messages.at(-1);
  if (last?.role === "toolResult") {
    return fauxAssistantMessage([
      fauxText(
        `${last.isError ? "tool failed" : "tool said"}: ${textOf(last.content)}`
      ),
    ]);
  }
  const rawPrompt = last?.role === "user" ? textOf(last.content) : "";
  const prompt = typedText(rawPrompt);
  if (prompt.startsWith(FAIL_PREFIX)) {
    return fauxAssistantMessage([], {
      errorMessage: prompt.slice(FAIL_PREFIX.length),
      stopReason: "error",
    });
  }
  if (prompt.startsWith(BASH_PREFIX)) {
    return fauxAssistantMessage(
      [
        fauxToolCall("harbourmaster_bash", {
          script: prompt.slice(BASH_PREFIX.length),
        }),
      ],
      { stopReason: "toolUse" }
    );
  }
  if (prompt.startsWith(SLOW_BASH_PREFIX)) {
    return fauxAssistantMessage(
      [
        fauxText("tick ".repeat(SLOW_REPEATS)),
        fauxToolCall("harbourmaster_bash", {
          script: prompt.slice(SLOW_BASH_PREFIX.length),
        }),
      ],
      { stopReason: "toolUse" }
    );
  }
  if (prompt.startsWith(CALL_PREFIX)) {
    const rest = prompt.slice(CALL_PREFIX.length);
    const space = rest.indexOf(" ");
    const name = space === -1 ? rest : rest.slice(0, space);
    const json = space === -1 ? "" : rest.slice(space + 1);
    return fauxAssistantMessage([fauxToolCall(name, argsOf(json))], {
      stopReason: "toolUse",
    });
  }
  if (prompt.startsWith(ASK_PREFIX)) {
    return fauxAssistantMessage(
      [
        fauxToolCall("ask_user", {
          question: prompt.slice(ASK_PREFIX.length),
        }),
      ],
      { stopReason: "toolUse" }
    );
  }
  if (prompt === GATED_PROMPT) {
    return fauxAssistantMessage([fauxToolCall(GATED_TOOL, {})], {
      stopReason: "toolUse",
    });
  }
  if (prompt === "slow") {
    return fauxAssistantMessage([fauxText("tick ".repeat(SLOW_REPEATS))]);
  }
  if (prompt.startsWith(SAY_PREFIX)) {
    return fauxAssistantMessage([fauxText(prompt.slice(SAY_PREFIX.length))]);
  }
  return fauxAssistantMessage([fauxText(`echo: ${rawPrompt}`)]);
};

/** The scripted provider. */
export const createFaux = () => {
  const faux = fauxProvider({
    tokenSize: { max: 4, min: 2 },
    tokensPerSecond: TOKENS_PER_SECOND,
  });
  faux.setResponses(Array.from({ length: RESPONSES }, () => fauxScript));
  return faux;
};
