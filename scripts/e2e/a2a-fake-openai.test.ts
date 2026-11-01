import { describe, expect, test } from "bun:test";
import { serve } from "bun";
import { filler, startFakeOpenAi } from "./a2a-fake-openai.ts";

const freePort = (): number => {
  const probe = serve({ fetch: () => new Response(""), port: 0 });
  const port = Number(probe.port);
  probe.stop(true);
  return port;
};

const chat = (url: string, messages: unknown[], stream = false) =>
  fetch(`${url}/chat/completions`, {
    body: JSON.stringify({ messages, model: "fake-model", stream }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

const user = (content: string) => [{ content, role: "user" }];

const deltaOf = (line: string): string => {
  const frame = JSON.parse(line.slice("data: ".length)) as {
    choices: { delta: { content?: string } }[];
  };
  const [choice] = frame.choices;
  return choice.delta.content ?? "";
};

describe("filler", () => {
  test.each([1, 6, 7, 40, 500])("returns exactly %i characters", (n) => {
    expect(filler(n).length).toBe(n);
  });

  test("ends with an end marker when longer than the marker", () => {
    expect(filler(100).endsWith(" [END]")).toBe(true);
  });
});

describe("startFakeOpenAi", () => {
  test("lists fake-model at /v1/models", async () => {
    const fake = startFakeOpenAi(freePort());
    try {
      const body = (await (await fetch(`${fake.url}/models`)).json()) as {
        data: { id: string }[];
      };
      const [model] = body.data;
      expect(model.id).toBe("fake-model");
    } finally {
      fake.stop();
    }
  });

  test("echoes the last user message in a non-streamed reply", async () => {
    const fake = startFakeOpenAi(freePort());
    try {
      const body = (await (await chat(fake.url, user("hello"))).json()) as {
        choices: { message: { content: string } }[];
      };
      const [choice] = body.choices;
      expect(choice.message.content).toBe("echo: hello");
    } finally {
      fake.stop();
    }
  });

  test("answers a CALL marker with a tool call carrying those arguments", async () => {
    const fake = startFakeOpenAi(freePort());
    try {
      const body = (await (
        await chat(fake.url, user('CALL a2a_call {"agent":"x"}'))
      ).json()) as {
        choices: {
          finish_reason: string;
          message: {
            tool_calls: { function: { arguments: string; name: string } }[];
          };
        }[];
      };
      const [choice] = body.choices;
      const [call] = choice.message.tool_calls;
      expect(choice.finish_reason).toBe("tool_calls");
      expect(call.function.name).toBe("a2a_call");
      expect(call.function.arguments).toBe('{"agent":"x"}');
    } finally {
      fake.stop();
    }
  });

  test("reports a tool result from a last message with role tool", async () => {
    const fake = startFakeOpenAi(freePort());
    try {
      const messages = [
        { content: "CALL a2a_call {}", role: "user" },
        { content: "result text", role: "tool", tool_call_id: "c1" },
      ];
      const body = (await (await chat(fake.url, messages)).json()) as {
        choices: { message: { content: string } }[];
      };
      const [choice] = body.choices;
      expect(choice.message.content).toBe("tool said: result text");
    } finally {
      fake.stop();
    }
  });

  test("replies with a 500 character answer to a LONG marker", async () => {
    const fake = startFakeOpenAi(freePort());
    try {
      const body = (await (
        await chat(fake.url, user("[[LONG 500]]"))
      ).json()) as { choices: { message: { content: string } }[] };
      const [choice] = body.choices;
      expect(choice.message.content.length).toBe(500);
    } finally {
      fake.stop();
    }
  });

  test("streams the same content as the non-streamed reply, ending with DONE", async () => {
    const fake = startFakeOpenAi(freePort());
    try {
      const plain = (await (await chat(fake.url, user("hello"))).json()) as {
        choices: { message: { content: string } }[];
      };
      const [plainChoice] = plain.choices;
      const streamed = await chat(fake.url, user("hello"), true);
      expect(streamed.headers.get("content-type")).toContain(
        "text/event-stream"
      );
      const text = await streamed.text();
      expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
      const reassembled = text
        .split("\n")
        .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
        .map(deltaOf)
        .join("");
      expect(reassembled).toBe(plainChoice.message.content);
    } finally {
      fake.stop();
    }
  });

  test("waits at least 200 ms for a SLOW marker", async () => {
    const fake = startFakeOpenAi(freePort());
    try {
      const started = performance.now();
      await chat(fake.url, user("[[SLOW 200]]"));
      expect(performance.now() - started).toBeGreaterThanOrEqual(200);
    } finally {
      fake.stop();
    }
  });
});
