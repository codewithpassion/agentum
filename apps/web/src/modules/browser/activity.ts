import { truncateText } from "#/modules/computer/output";

/**
 * One-line summaries of what an agent did in its browser, written the way a
 * person would say it - the activity feed shows these alone, without the detail
 * JSON beside them.
 */

const SUMMARY_MAX_BYTES = 120;

const shorten = (text: string): string => {
  const result = truncateText(text.trim(), SUMMARY_MAX_BYTES);
  return result.truncated ? `${result.text}…` : result.text;
};

export const summarizeNavigate = (input: {
  title: string;
  url: string;
}): string =>
  input.title
    ? `Opened ${shorten(input.title)} (${shorten(input.url)})`
    : `Opened ${shorten(input.url)}`;

export const summarizeClick = (input: {
  selector: string;
  url: string;
}): string => `Clicked ${shorten(input.selector)} on ${shorten(input.url)}`;

/**
 * The value is never in the summary and never in the detail: an agent filling a
 * login form would otherwise write a password into a table the UI renders.
 */
export const summarizeFill = (input: {
  selector: string;
  url: string;
}): string => `Filled ${shorten(input.selector)} on ${shorten(input.url)}`;

export const summarizeScreenshot = (input: { url: string }): string =>
  `Screenshot of ${shorten(input.url)}`;
