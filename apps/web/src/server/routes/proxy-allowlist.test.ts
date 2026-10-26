import { describe, expect, test } from "bun:test";
import { filterToolsList } from "./proxy-allowlist.ts";

const ECHO = {
  description: "Echo",
  inputSchema: { type: "object" },
  name: "echo",
};
const SHOUT = {
  description: "Shout",
  inputSchema: { type: "object" },
  name: "shout",
};
const SEARCH = { name: "search" };
const ALLOWED = new Set(["echo"]);

const listAnswer = (id: number, tools: unknown[]) => ({
  id,
  jsonrpc: "2.0",
  result: { tools },
});

describe("filterToolsList", () => {
  test("a JSON object answer keeps only the allowed tools", () => {
    const text = JSON.stringify(listAnswer(1, [ECHO, SHOUT]));

    const out = filterToolsList(text, "application/json", ALLOWED);

    expect(JSON.parse(out ?? "null")).toEqual(listAnswer(1, [ECHO]));
  });

  test("a JSON batch answer filters each message and leaves the others alone", () => {
    const other = { id: 2, jsonrpc: "2.0", result: { ok: true } };
    const text = JSON.stringify([listAnswer(1, [ECHO, SHOUT]), other]);

    const out = filterToolsList(
      text,
      "application/json; charset=utf-8",
      ALLOWED
    );

    expect(JSON.parse(out ?? "null")).toEqual([listAnswer(1, [ECHO]), other]);
  });

  test("an SSE answer changes only the tools/list event and passes the rest through", () => {
    const text = [
      `id: 1\ndata: ${JSON.stringify(listAnswer(1, [ECHO, SHOUT]))}`,
      ": keep-alive",
      `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })}`,
    ].join("\n\n");

    const out = filterToolsList(text, "text/event-stream", ALLOWED);

    expect(out).toBe(
      [
        `id: 1\ndata: ${JSON.stringify(listAnswer(1, [ECHO]))}`,
        ": keep-alive",
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })}`,
      ].join("\n\n")
    );
  });

  test("an SSE event whose data is not JSON makes the answer unreadable", () => {
    const text = `data: ${JSON.stringify(listAnswer(1, [ECHO, SHOUT]))}\n\ndata: not json`;

    expect(filterToolsList(text, "text/event-stream", ALLOWED)).toBeNull();
  });

  test("an SSE answer with bare CR line breaks is filtered", () => {
    const text = `id: 1\rdata: ${JSON.stringify(listAnswer(1, [ECHO, SHOUT]))}\r\r`;

    const out = filterToolsList(text, "text/event-stream", ALLOWED);

    expect(out).toContain(`data: ${JSON.stringify(listAnswer(1, [ECHO]))}`);
    expect(out).not.toContain("shout");
  });

  test("an SSE answer with CRLF line breaks is filtered", () => {
    const text = `id: 1\r\ndata: ${JSON.stringify(listAnswer(1, [ECHO, SHOUT]))}\r\n\r\n`;

    const out = filterToolsList(text, "text/event-stream", ALLOWED);

    expect(out).toContain(`data: ${JSON.stringify(listAnswer(1, [ECHO]))}`);
    expect(out).not.toContain("shout");
  });

  test("a tool named in the list but not allowed is dropped, and an allowed one stays as it was", () => {
    const text = JSON.stringify(listAnswer(1, [SHOUT, ECHO, SEARCH]));

    const out = JSON.parse(
      filterToolsList(text, "application/json", ALLOWED) ?? "null"
    );

    expect(out.result.tools).toEqual([ECHO]);
  });

  test("an allowlist with no names empties the tool list", () => {
    const text = JSON.stringify(listAnswer(1, [ECHO]));

    const out = filterToolsList(text, "application/json", new Set());

    expect(JSON.parse(out ?? "null")).toEqual(listAnswer(1, []));
  });

  test("invalid JSON under a JSON content type returns null", () => {
    expect(
      filterToolsList("{not json", "application/json", ALLOWED)
    ).toBeNull();
  });

  test("an unreadable content type returns null", () => {
    const text = JSON.stringify(listAnswer(1, [ECHO]));

    expect(filterToolsList(text, "text/html", ALLOWED)).toBeNull();
    expect(filterToolsList(text, null, ALLOWED)).toBeNull();
  });
});
