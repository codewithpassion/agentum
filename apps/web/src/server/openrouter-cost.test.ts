import { describe, expect, test } from "bun:test";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Usage,
} from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { createCostProbe, withReportedCost } from "./openrouter-cost.ts";

const REPORTED_COST = 0.0042;
const LATER_COST = 0.0007;
const ESTIMATED_TOTAL = 0.0009;
const PRIOR_INPUT_COST = 0.0001;
const PRIOR_OUTPUT_COST = 0.0002;
const PRIOR_CACHE_READ_COST = 0.000_03;
const PRIOR_CACHE_WRITE_COST = 0.000_04;
const TOKENS = 3;

const usage = (total: number): Usage => ({
  cacheRead: 0,
  cacheWrite: 0,
  cost: {
    cacheRead: PRIOR_CACHE_READ_COST,
    cacheWrite: PRIOR_CACHE_WRITE_COST,
    input: PRIOR_INPUT_COST,
    output: PRIOR_OUTPUT_COST,
    total,
  },
  input: TOKENS,
  output: TOKENS,
  totalTokens: TOKENS * 2,
});

const assistantMessage = (total = ESTIMATED_TOTAL): AssistantMessage => ({
  api: "openai-completions",
  content: [{ text: "pelican", type: "text" }],
  model: "z-ai/glm-5.3",
  provider: "openrouter",
  role: "assistant",
  stopReason: "stop",
  timestamp: 1,
  usage: usage(total),
});

const streamOf = (
  ...events: Parameters<AssistantMessageEventStream["push"]>[0][]
): AssistantMessageEventStream => {
  const source = new AssistantMessageEventStream();
  for (const event of events) {
    source.push(event);
  }
  source.end();
  return source;
};

const drain = async (
  stream: AssistantMessageEventStream
): Promise<AssistantMessageEvent[]> => {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
};

describe("createCostProbe", () => {
  test("ignores values that are not objects", () => {
    const probe = createCostProbe();
    for (const value of [undefined, null, "cost", 0.5, true]) {
      probe.observe(value);
    }
    expect(probe.cost()).toBeUndefined();
  });

  test("ignores chunks without a usage object or without a cost", () => {
    const probe = createCostProbe();
    probe.observe({});
    probe.observe({ usage: null });
    probe.observe({ usage: { prompt_tokens: 1 } });
    expect(probe.cost()).toBeUndefined();
  });

  test("ignores negative, NaN, infinite and string costs", () => {
    const probe = createCostProbe();
    for (const cost of [
      -REPORTED_COST,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "0.0042",
    ]) {
      probe.observe({ usage: { cost } });
    }
    expect(probe.cost()).toBeUndefined();
  });

  test("keeps the latest valid cost and skips invalid ones after it", () => {
    const probe = createCostProbe();
    probe.observe({ usage: { cost: REPORTED_COST } });
    probe.observe({ usage: { cost: "bad" } });
    expect(probe.cost()).toBe(REPORTED_COST);
    probe.observe({ usage: { cost: LATER_COST } });
    probe.observe({ usage: { cost: -1 } });
    expect(probe.cost()).toBe(LATER_COST);
  });

  test("accepts a zero cost", () => {
    const probe = createCostProbe();
    probe.observe({ usage: { cost: 0 } });
    expect(probe.cost()).toBe(0);
  });
});

describe("withReportedCost", () => {
  test("patches cost.total on a done event and forwards events unchanged", async () => {
    const probe = createCostProbe();
    probe.observe({ usage: { cost: REPORTED_COST } });
    const message = assistantMessage();
    const start = { partial: message, type: "start" as const };
    const done = { message, reason: "stop" as const, type: "done" as const };
    const stream = withReportedCost(streamOf(start, done), probe);

    const events = await drain(stream);

    expect(events).toHaveLength(2);
    expect(events[0]).toBe(start);
    expect(events[1]).toBe(done);
    expect(message.usage.cost.total).toBe(REPORTED_COST);
    expect(message.usage.cost.input).toBe(PRIOR_INPUT_COST);
    expect(message.usage.cost.output).toBe(PRIOR_OUTPUT_COST);
    expect(message.usage.cost.cacheRead).toBe(PRIOR_CACHE_READ_COST);
    expect(message.usage.cost.cacheWrite).toBe(PRIOR_CACHE_WRITE_COST);
  });

  test("keeps cost.total when the probe has no cost", async () => {
    const message = assistantMessage();
    const done = { message, reason: "stop" as const, type: "done" as const };
    const stream = withReportedCost(streamOf(done), createCostProbe());

    await drain(stream);

    expect(message.usage.cost.total).toBe(ESTIMATED_TOTAL);
  });

  test("patches cost.total on an error event and keeps it when the probe has no cost", async () => {
    const probe = createCostProbe();
    probe.observe({ usage: { cost: REPORTED_COST } });
    const failed = assistantMessage();
    failed.stopReason = "error";
    const error = {
      error: failed,
      reason: "error" as const,
      type: "error" as const,
    };
    const patched = withReportedCost(streamOf(error), probe);
    await drain(patched);
    expect(failed.usage.cost.total).toBe(REPORTED_COST);

    const unreported = assistantMessage();
    const unreportedError = {
      error: unreported,
      reason: "error" as const,
      type: "error" as const,
    };
    await drain(withReportedCost(streamOf(unreportedError), createCostProbe()));
    expect(unreported.usage.cost.total).toBe(ESTIMATED_TOTAL);
  });

  test("result() resolves to the patched message", async () => {
    const probe = createCostProbe();
    probe.observe({ usage: { cost: REPORTED_COST } });
    const message = assistantMessage();
    const done = { message, reason: "stop" as const, type: "done" as const };
    const stream = withReportedCost(streamOf(done), probe);

    const result = await stream.result();

    expect(result).toBe(message);
    expect(result.usage.cost.total).toBe(REPORTED_COST);
  });

  test("ends the new stream when the source throws", async () => {
    class FailingStream extends AssistantMessageEventStream {
      override [Symbol.asyncIterator]() {
        return {
          next: () => Promise.reject(new Error("upstream failed")),
        };
      }
    }
    const stream = withReportedCost(new FailingStream(), createCostProbe());

    expect(await drain(stream)).toEqual([]);
  });
});
