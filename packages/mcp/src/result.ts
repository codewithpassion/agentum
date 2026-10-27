/**
 * Tool results as MCP results. Every successful tool answers with
 * `structuredContent` (the plain data) and a text rendering, because an agent
 * on an older client sees only the text.
 */
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { ToolImage } from "./ports";

/** What a tool's `run` returns. */
export interface ToolPayload {
  /** Goes out as `structuredContent`; always an object, never an array. */
  data: object;
  image?: ToolImage;
  /** Short rendering of `data` for clients that show text only. */
  text: string;
}

export type ToolErrorCode =
  | "forbidden"
  | "validation"
  | "not_found"
  | "conflict"
  | "guard_mismatch"
  | "block_gone"
  | "anchor_conflict"
  | "find_none"
  | "find_ambiguous";

/** A failure a tool means to show the agent: its code and message say what to do next. */
export class ToolError extends Error {
  readonly code: ToolErrorCode;

  constructor(code: ToolErrorCode, message: string) {
    super(message);
    this.name = "ToolError";
    this.code = code;
  }
}

/** Said instead of anything internal when a non-`ToolError` escapes. */
const GENERIC_ERROR =
  "The request failed. Try again; if it keeps failing, check Harbourmaster.";

export const toolResult = (payload: ToolPayload): CallToolResult => ({
  content: [
    { text: payload.text, type: "text" },
    ...(payload.image ? [{ ...payload.image, type: "image" as const }] : []),
  ],
  structuredContent: payload.data,
});

/**
 * A failed call. A `ToolError` keeps its code and message. Anything else says
 * nothing about internals, and no stack ever reaches the client.
 */
export const errorResult = (error: unknown): CallToolResult =>
  error instanceof ToolError
    ? {
        content: [{ text: `${error.code}: ${error.message}`, type: "text" }],
        isError: true,
        structuredContent: { code: error.code, message: error.message },
      }
    : {
        content: [{ text: GENERIC_ERROR, type: "text" }],
        isError: true,
      };

/**
 * Runs `work` and turns whatever it throws into an error result: the SDK
 * would otherwise put the raw `Error` message on the wire.
 */
export const runSafely = async (
  work: () => Promise<ToolPayload>
): Promise<CallToolResult> => {
  try {
    return toolResult(await work());
  } catch (error) {
    return errorResult(error);
  }
};
