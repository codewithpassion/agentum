// What a dry run lets through. A dry run runs the agent without side effects:
// a read-only call goes ahead, and any other call is skipped with a line that
// says what it would have done. Kept free of `cloudflare:workers` and of I/O so
// bun can test it; the run supplies the tool origins and the masker.
import type { Masker } from "@repo/protocol/masker";
import type { ToolOrigin } from "./pi-run-mcp.ts";

/** The longest summary of a skipped call's input, ellipsis included. */
export const DRY_RUN_SUMMARY_MAX = 200;

/** The answer an `ask_user` call gets in a dry run. */
export const ASK_USER_DRY_RUN_TEXT =
  "Nobody answers in a dry run. Go on with a stated assumption.";

/** The answer a `request_human_takeover` call gets in a dry run. */
export const TAKEOVER_DRY_RUN_TEXT =
  "Nobody takes over the computer in a dry run. Go on without it and say what you could not do.";

const ELLIPSIS = "…";
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "activate_skill",
  "desktop_screenshot",
  "read",
  "read_input_file",
  "read_skill_resource",
]);

/**
 * Whether a dry run lets the call go ahead. An MCP tool is read-only only when
 * its server marked it so. A `web_fetch` is read-only when it is a GET.
 */
export const isReadOnlyCall = (
  call: { arguments: Record<string, unknown>; name: string },
  origin?: ToolOrigin
): boolean => {
  if (origin) {
    return origin.readOnly;
  }
  if (call.name === "web_fetch") {
    const { method } = call.arguments;
    return (
      method === undefined ||
      (typeof method === "string" && method.toUpperCase() === "GET")
    );
  }
  return READ_ONLY_TOOLS.has(call.name);
};

/**
 * The input of a skipped call as a short line. The text is masked before it is
 * cut, so a secret is replaced whole and never split by the cut.
 */
export const summaryOf = (
  args: Record<string, unknown>,
  masker: Masker | null
): string => {
  if (Object.keys(args).length === 0) {
    return "no input";
  }
  const json = JSON.stringify(args);
  const masked = masker ? masker.mask(json) : json;
  if (masked.length <= DRY_RUN_SUMMARY_MAX) {
    return masked;
  }
  return `${masked.slice(0, DRY_RUN_SUMMARY_MAX - ELLIPSIS.length)}${ELLIPSIS}`;
};

/** The result a skipped call gets back to the model. */
export const skippedText = (tool: string, summary: string): string =>
  `Skipped in dry run: would call ${tool} with ${summary}`;
