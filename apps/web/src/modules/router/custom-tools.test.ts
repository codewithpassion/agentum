import { describe, expect, mock, test } from "bun:test";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  env: {},
}));

const { answerCustomTools, runCustomTool } = await import("./custom-tools");

type Result = import("#/modules/anthropic/gateway").CustomToolResult;
type Answer = Omit<Result, "toolUseId">;

const memory = () => {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string) => Promise.resolve(values.get(key) as T | undefined),
    put: (key: string, value: unknown) => {
      values.set(key, value);
      return Promise.resolve();
    },
  };
};

const SHOT: Answer = {
  image: { base64: "AAAA", mediaType: "image/jpeg" },
  isError: false,
  text: "Screenshot",
};

const harness = (answer: (name: string) => Answer = () => SHOT) => {
  const storage = memory();
  const sent: Result[] = [];
  const ran: string[] = [];
  const deps = {
    run: (name: string) => {
      ran.push(name);
      return Promise.resolve(answer(name));
    },
    send: (result: Result) => {
      sent.push(result);
      return Promise.resolve();
    },
    sessionId: "sesn_1",
    storage,
  };
  return { deps, ran, sent };
};

const use = { id: "evt_1", name: "desktop_screenshot" };

describe("answerCustomTools", () => {
  test("runs the call the session is blocked on and sends the result", async () => {
    const { deps, ran, sent } = harness();

    const answered = await answerCustomTools(deps, [use], ["evt_1"]);

    expect(answered).toBe(1);
    expect(ran).toEqual(["desktop_screenshot"]);
    expect(sent).toEqual([{ ...SHOT, toolUseId: "evt_1" }]);
  });

  test("passes a failure through as an error result", async () => {
    const { deps, sent } = harness(() => ({
      isError: true,
      text: "The desktop on this computer is not running.",
    }));

    await answerCustomTools(deps, [use], ["evt_1"]);

    expect(sent).toEqual([
      {
        isError: true,
        text: "The desktop on this computer is not running.",
        toolUseId: "evt_1",
      },
    ]);
  });

  test("answers each call exactly once, however often it is read again", async () => {
    const { deps, ran, sent } = harness();

    await answerCustomTools(deps, [use], ["evt_1"]);
    // The poll window overlaps, and the idle is re-emitted with the remainder.
    await answerCustomTools(deps, [use], ["evt_1"]);
    await answerCustomTools(deps, [], ["evt_1"]);

    expect(ran).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  test("waits for the idle: a call alone is remembered, not answered", async () => {
    const { deps, sent } = harness();

    expect(await answerCustomTools(deps, [use], [])).toBe(0);
    expect(sent).toEqual([]);

    // The idle arrives in a later page, without the call.
    expect(await answerCustomTools(deps, [], ["evt_1"])).toBe(1);
    expect(sent).toHaveLength(1);
  });

  test("answers several calls in the order raised", async () => {
    const { deps, sent } = harness();

    await answerCustomTools(
      deps,
      [use, { id: "evt_2", name: "desktop_screenshot" }],
      ["evt_1", "evt_2"]
    );

    expect(sent.map((result) => result.toolUseId)).toEqual(["evt_1", "evt_2"]);
  });

  test("leaves an id it never saw a call for", async () => {
    const { deps, sent } = harness();

    expect(await answerCustomTools(deps, [], ["evt_other"])).toBe(0);
    expect(sent).toEqual([]);
  });
});

describe("runCustomTool", () => {
  test("an unknown tool name is an error result", async () => {
    const answer = await runCustomTool(
      {} as never,
      {} as Env,
      undefined,
      "make_coffee"
    );

    expect(answer).toEqual({ isError: true, text: "unknown tool" });
  });
});
