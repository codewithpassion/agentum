import { redactText } from "@repo/services/events/scrub";
import { ARTIFACT_TEST_VIEWPORTS, type ArtifactTestResult } from "./driver.ts";

/**
 * The text `artifact_test` returns. Pure, and bounded: Pi agents read this
 * instead of the screenshot, so what broke comes first and the page text last,
 * where the size cap cuts it.
 */

export const MAX_RESULT_BYTES = 16_000;
const MAX_LISTED = 20;
const MAX_ENTRY_CHARS = 300;
const MAX_LINKS_LISTED = 20;

const clip = (text: string, limit: number): string => {
  const flat = redactText(text).replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}...` : flat;
};

const section = <T>(
  heading: string,
  items: T[],
  line: (item: T) => string
): string => {
  if (items.length === 0) {
    return `${heading}: none`;
  }
  const lines = items.slice(0, MAX_LISTED).map((item) => `- ${line(item)}`);
  if (items.length > MAX_LISTED) {
    lines.push(`- ... and ${items.length - MAX_LISTED} more`);
  }
  return `${heading} (${items.length}):\n${lines.join("\n")}`;
};

const truncateBytes = (text: string, limit: number): string => {
  const encoder = new TextEncoder();
  if (encoder.encode(text).byteLength <= limit) {
    return text;
  }
  const marker = "\n[result truncated]";
  const budget = limit - encoder.encode(marker).byteLength;
  let bytes = 0;
  let kept = "";
  for (const character of text) {
    const size = encoder.encode(character).byteLength;
    if (bytes + size > budget) {
      break;
    }
    kept += character;
    bytes += size;
  }
  return `${kept}${marker}`;
};

export const formatArtifactTestResult = (
  result: ArtifactTestResult,
  maxBytes: number = MAX_RESULT_BYTES
): string => {
  const { height, width } = ARTIFACT_TEST_VIEWPORTS[result.viewport];
  const { snapshot } = result;
  const parts = [
    `Artifact test at ${result.viewport} (${width}x${height})`,
    `Title: ${clip(result.title, MAX_ENTRY_CHARS) || "(untitled)"}`,
    result.loadError
      ? `Load: FAILED, ${clip(result.loadError, MAX_ENTRY_CHARS)}`
      : "Load: ok",
    section(
      "Console errors and warnings",
      result.consoleEntries,
      (entry) => `[${entry.level}] ${clip(entry.text, MAX_ENTRY_CHARS)}`
    ),
    section(
      "Failed requests",
      result.failedRequests,
      (request) =>
        `${request.method} ${clip(request.url, MAX_ENTRY_CHARS)}: ${clip(request.reason, MAX_ENTRY_CHARS)}`
    ),
    section(
      "Responses with status 400 or higher",
      result.badResponses,
      (response) => `${response.status} ${clip(response.url, MAX_ENTRY_CHARS)}`
    ),
    `Page text${snapshot.textTruncated ? " (cut)" : ""}:\n${redactText(snapshot.text) || "(empty)"}`,
  ];
  if (snapshot.links.length > 0) {
    const links = snapshot.links
      .slice(0, MAX_LINKS_LISTED)
      .map(
        (link) =>
          `- ${clip(link.text, 80) || "(no text)"} -> ${clip(link.href, 200)}`
      );
    if (snapshot.links.length > MAX_LINKS_LISTED) {
      links.push(`- ... and ${snapshot.links.length - MAX_LINKS_LISTED} more`);
    }
    parts.push(`Links (${snapshot.links.length}):\n${links.join("\n")}`);
  }
  return truncateBytes(parts.join("\n\n"), maxBytes);
};
