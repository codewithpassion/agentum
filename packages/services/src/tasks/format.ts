import type { KeyChip } from "@repo/db/shared";
import { stripAttachmentMarkers } from "@repo/protocol/attachments";
import type { EventRecord } from "../events.ts";

export const text = (value: unknown): string =>
  typeof value === "string" ? stripAttachmentMarkers(value).trim() : "";

export const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export const payloadOf = (event: EventRecord): Record<string, unknown> =>
  event.payloadRef ? {} : event.payload;

const CAMEL_CASE = /([a-z0-9])([A-Z])/g;
const SEPARATORS = /[_./-]+/g;
export const toolWords = (value: unknown): string => {
  const words = text(value)
    .replace(CAMEL_CASE, "$1 $2")
    .replace(SEPARATORS, " ")
    .trim();
  return words ? words[0]?.toUpperCase() + words.slice(1) : "Tool call";
};

// The task leaves truncation unspecified: use 80 display characters including ellipsis.
export const chips = (value: unknown): KeyChip[] =>
  Object.entries(object(value))
    .filter(
      ([, item]) =>
        item === null || ["string", "number", "boolean"].includes(typeof item)
    )
    .slice(0, 3)
    .map(([key, item]) => {
      const valueText = text(typeof item === "string" ? item : String(item));
      return {
        key: text(key),
        value: valueText.length > 80 ? `${valueText.slice(0, 79)}…` : valueText,
      };
    });

export const parseOutput = (value: unknown): unknown => {
  if (typeof value !== "string") {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
};

const SENTENCE_END = /^.*?[.!?](?=\s|$)/s;
export const sentence = (value: unknown, fallback: string): string => {
  const clean = text(value).replace(/\s+/g, " ");
  return clean.match(SENTENCE_END)?.[0] ?? (clean || fallback);
};

export const requestDetail = (display: unknown): string => {
  const data = object(display);
  const { questions } = data;
  return (
    text(data.summary) ||
    (Array.isArray(questions) ? text(object(questions[0]).question) : "")
  );
};
