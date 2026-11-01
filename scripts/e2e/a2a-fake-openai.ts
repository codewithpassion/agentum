// A fake OpenAI-compatible model endpoint for the Hermes interop script
// (scripts/e2e/a2a-hermes.ts), so Hermes needs no key and costs nothing. It
// answers `POST /v1/chat/completions`, streamed or not, from the last user
// message alone:
//
//   `CALL <tool> <json>`  a tool call with the JSON object as its arguments.
//                          After the tool answers, the model replies with
//                          `tool said: <tool output>` so the script can read it.
//   `[[SLOW <ms>]]`        waits that long before the reply.
//   `[[LONG <chars>]]`     a reply of that many characters.
//   anything else          `echo: <the text>`.
//
// The markers may sit anywhere in the message, because Hermes wraps what a
// peer sends in its own framing before the model sees it.

import { serve, sleep } from "bun";

export interface FakeOpenAi {
  /** Every request the endpoint has seen, as the last user message and the tool results. */
  calls: { tool: string | null; user: string }[];
  port: number;
  stop: () => void;
  url: string;
}

interface ChatMessage {
  content?: unknown;
  role: string;
  tool_call_id?: string;
}

const CALL = /CALL\s+(\S+)\s+(\{[\s\S]*\})/;
const SLOW = /\[\[SLOW (\d+)\]\]/;
const LONG = /\[\[LONG (\d+)\]\]/;

const textOf = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "object" && part !== null && "text" in part
          ? String((part as { text: unknown }).text)
          : ""
      )
      .join("");
  }
  return "";
};

/** `n` characters of readable filler that ends in a marker, so a cut-off shows. */
export const filler = (n: number): string => {
  const unit = "The quick brown fox jumps over the lazy dog. ";
  const body = unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  const end = " [END]";
  return n > end.length ? body.slice(0, n - end.length) + end : body;
};

const completion = (
  content: string | null,
  toolCall?: { args: string; name: string }
) => ({
  choices: [
    {
      finish_reason: toolCall ? "tool_calls" : "stop",
      index: 0,
      message: {
        content,
        role: "assistant",
        ...(toolCall
          ? {
              tool_calls: [
                {
                  function: { arguments: toolCall.args, name: toolCall.name },
                  id: `call_${crypto.randomUUID().slice(0, 8)}`,
                  type: "function",
                },
              ],
            }
          : {}),
      },
    },
  ],
  created: Math.floor(Date.now() / 1000),
  id: `chatcmpl-${crypto.randomUUID()}`,
  model: "fake-model",
  object: "chat.completion",
  usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
});

/** The same completion as a stream of chat.completion.chunk events. */
const streamed = (full: ReturnType<typeof completion>): Response => {
  const [choice] = full.choices;
  const base = {
    created: full.created,
    id: full.id,
    model: full.model,
    object: "chat.completion.chunk",
  };
  const frames: unknown[] = [
    { ...base, choices: [{ delta: { role: "assistant" }, index: 0 }] },
  ];
  if (choice?.message.tool_calls) {
    frames.push({
      ...base,
      choices: [
        {
          delta: {
            tool_calls: choice.message.tool_calls.map((call, index) => ({
              ...call,
              index,
            })),
          },
          index: 0,
        },
      ],
    });
  } else if (choice?.message.content) {
    const text = choice.message.content;
    const size = 400;
    for (let at = 0; at < text.length; at += size) {
      frames.push({
        ...base,
        choices: [{ delta: { content: text.slice(at, at + size) }, index: 0 }],
      });
    }
  }
  frames.push({
    ...base,
    choices: [{ delta: {}, finish_reason: choice?.finish_reason, index: 0 }],
    usage: full.usage,
  });
  const body = `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    headers: {
      "Cache-Control": "no-cache",
      "Content-Type": "text/event-stream",
    },
  });
};

export const startFakeOpenAi = (port: number): FakeOpenAi => {
  const calls: FakeOpenAi["calls"] = [];
  const server = serve({
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/models")) {
        return Response.json({
          data: [{ id: "fake-model", object: "model" }],
          object: "list",
        });
      }
      if (!url.pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }
      const body = (await request.json()) as {
        messages?: ChatMessage[];
        stream?: boolean;
      };
      const messages = body.messages ?? [];
      const last = messages.at(-1);
      const lastUser = [...messages]
        .reverse()
        .find((message) => message.role === "user");
      const user = textOf(lastUser?.content);
      calls.push({
        tool: last?.role === "tool" ? textOf(last.content) : null,
        user,
      });
      let reply: ReturnType<typeof completion>;
      const call = CALL.exec(user);
      if (last?.role === "tool") {
        reply = completion(`tool said: ${textOf(last.content)}`);
      } else if (call?.[1] && call[2]) {
        reply = completion(null, { args: call[2], name: call[1] });
      } else {
        const slow = SLOW.exec(user);
        if (slow?.[1]) {
          await sleep(Number(slow[1]));
        }
        const long = LONG.exec(user);
        reply = completion(
          long?.[1] ? filler(Number(long[1])) : `echo: ${user.slice(0, 200)}`
        );
      }
      return body.stream ? streamed(reply) : Response.json(reply);
    },
    idleTimeout: 0,
    port,
  });
  return {
    calls,
    port,
    stop: () => server.stop(true),
    url: `http://127.0.0.1:${port}/v1`,
  };
};
