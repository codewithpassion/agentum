/// <reference types="bun" />
import { expect, test } from "bun:test";
import type { McpPorts } from "@repo/mcp/ports";
import { inboxTools } from "@repo/mcp/tools/inbox";
import { buildWakeInput } from "@repo/services/inbox/wake-input";
import { z } from "zod";

const SENTENCE_START = "inbox_post takes ";
const NAME_SEPARATOR = / and |, /;

test("the wake text names the inbox_post arguments the tool schema takes", () => {
  const tool = inboxTools({} as unknown as McpPorts).find(
    (candidate) => candidate.name === "inbox_post"
  );
  if (!tool) {
    throw new Error("inbox_post tool is not defined");
  }
  if (!(tool.inputSchema instanceof z.ZodObject)) {
    throw new Error("inbox_post input schema is not a zod object");
  }
  const schemaKeys = Object.keys(tool.inputSchema.shape).sort();

  const wakeText = buildWakeInput({ earlier: [], text: "hi", threadId: "t1" });
  const start = wakeText.indexOf(SENTENCE_START);
  expect(start).toBeGreaterThanOrEqual(0);
  const argsStart = start + SENTENCE_START.length;
  const argsEnd = wakeText.indexOf(".", argsStart);
  expect(argsEnd).toBeGreaterThan(argsStart);

  const wakeKeys = wakeText
    .slice(argsStart, argsEnd)
    .split(NAME_SEPARATOR)
    .map((name) => name.trim())
    .sort();

  expect(wakeKeys).toEqual(schemaKeys);
});
