// A scripted model for local checks. `PiRun` loads this module in dev builds
// only, behind `import.meta.env.DEV`, so a deployed Worker cannot reach it. An
// agent whose model is `faux` answers from its prompt alone, with no API key.
import {
  type AssistantMessage,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Message,
  type TranscriptContext,
} from "@earendil-works/pi-ai";

export const FAUX_MODEL = "faux";

const RESPONSES = 1000;
const TOKENS_PER_SECOND = 200;
const SLOW_REPEATS = 4000;
const BASH_PREFIX = "bash ";
const FAIL_PREFIX = "fail ";

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
 * the platform's library `bash` tool, then repeats what it said.
 */
const script = (context: TranscriptContext): AssistantMessage => {
  const last = context.messages.at(-1);
  if (last?.role === "toolResult") {
    return fauxAssistantMessage([
      fauxText(
        `${last.isError ? "tool failed" : "tool said"}: ${textOf(last.content)}`
      ),
    ]);
  }
  const prompt = last?.role === "user" ? textOf(last.content) : "";
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
  if (prompt === "slow") {
    return fauxAssistantMessage([fauxText("tick ".repeat(SLOW_REPEATS))]);
  }
  return fauxAssistantMessage([fauxText(`echo: ${prompt}`)]);
};

/** The scripted provider. */
export const createFaux = () => {
  const faux = fauxProvider({
    tokenSize: { max: 4, min: 2 },
    tokensPerSecond: TOKENS_PER_SECOND,
  });
  faux.setResponses(Array.from({ length: RESPONSES }, () => script));
  return faux;
};
