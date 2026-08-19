import { truncateText } from "./output";

/**
 * One-line summaries of what an agent did to its computer. They are what the
 * activity feed shows, so they read as a person would say them and never
 * require the detail JSON to make sense.
 */

const SUMMARY_COMMAND_MAX_BYTES = 120;

const shorten = (text: string, maxBytes: number): string => {
  const result = truncateText(text.replace(/\s+/g, " ").trim(), maxBytes);
  return result.truncated ? `${result.text}…` : result.text;
};

export const summarizeWrite = (input: {
  created: boolean;
  path: string;
  size: number;
}): string =>
  `${input.created ? "Created" : "Wrote"} ${input.path} (${input.size} bytes)`;

export const summarizeEdit = (input: { path: string }): string =>
  `Edited ${input.path}`;

export const summarizeExec = (input: {
  command: string;
  exitCode: number;
}): string => {
  const command = shorten(input.command, SUMMARY_COMMAND_MAX_BYTES);
  return input.exitCode === 0
    ? `$ ${command}`
    : `$ ${command} (exit ${input.exitCode})`;
};

export const summarizeExecFailure = (input: {
  command: string;
  reason: string;
}): string =>
  `$ ${shorten(input.command, SUMMARY_COMMAND_MAX_BYTES)} (failed: ${shorten(input.reason, SUMMARY_COMMAND_MAX_BYTES)})`;
