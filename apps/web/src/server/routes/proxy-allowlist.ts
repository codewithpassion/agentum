// The per-agent tool allowlist for the connector proxy (`proxy.ts`). Pure
// functions: what a `tools/call` may name, and how a `tools/list` answer is cut
// down to the allowed tools. The answer is JSON or an SSE stream of JSON
// messages, and a body that cannot be read is refused rather than passed on.

const SSE_EVENT_BREAK = /\r?\n\r?\n/;
const SSE_LINE_BREAK = /\r?\n/;
const SSE_DATA_PREFIX = /^data: ?/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The message with its `result.tools` cut to the allowed names. Other messages pass unchanged. */
const filterMessage = (
  message: unknown,
  allowed: ReadonlySet<string>
): unknown => {
  if (!(isRecord(message) && isRecord(message.result))) {
    return message;
  }
  const { tools } = message.result;
  if (!Array.isArray(tools)) {
    return message;
  }
  return {
    ...message,
    result: {
      ...message.result,
      tools: tools.filter(
        (tool) => isRecord(tool) && allowed.has(String(tool.name))
      ),
    },
  };
};

/** One SSE event with each JSON `data` payload filtered. Anything that is not JSON stays as sent. */
const filterEvent = (event: string, allowed: ReadonlySet<string>): string => {
  const lines = event.split(SSE_LINE_BREAK);
  const data = lines.filter((line) => SSE_DATA_PREFIX.test(line));
  if (data.length === 0) {
    return event;
  }
  const payload = data
    .map((line) => line.replace(SSE_DATA_PREFIX, ""))
    .join("\n");
  let message: unknown;
  try {
    message = JSON.parse(payload);
  } catch {
    return event;
  }
  const rewritten = `data: ${JSON.stringify(filterMessage(message, allowed))}`;
  let placed = false;
  return lines
    .flatMap((line) => {
      if (!SSE_DATA_PREFIX.test(line)) {
        return [line];
      }
      if (placed) {
        return [];
      }
      placed = true;
      return [rewritten];
    })
    .join("\n");
};

/**
 * A `tools/list` answer reduced to the allowed tools, as text. Null when the
 * body is not a JSON or SSE answer this can read, so the caller can refuse it.
 */
export const filterToolsList = (
  text: string,
  contentType: string | null,
  allowed: ReadonlySet<string>
): string | null => {
  const type = (contentType ?? "").toLowerCase();
  if (type.includes("text/event-stream")) {
    return text
      .split(SSE_EVENT_BREAK)
      .map((event) => filterEvent(event, allowed))
      .join("\n\n");
  }
  if (type.includes("json")) {
    try {
      const parsed: unknown = JSON.parse(text);
      return JSON.stringify(
        Array.isArray(parsed)
          ? parsed.map((message) => filterMessage(message, allowed))
          : filterMessage(parsed, allowed)
      );
    } catch {
      return null;
    }
  }
  return null;
};
