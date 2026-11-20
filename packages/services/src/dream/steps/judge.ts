// Ported from the-brain/packages/db/src/dream/judge.ts (the injected judge, the
// salvage parse, and the rule that a null or unparseable answer degrades and
// never throws) and from the-brain/packages/shared/src/json.ts
// (extractJsonCandidates, clampConfidence). The Brain's judge rules on a
// cluster of facts. Here the three steps in this folder each ask their own
// question of the same injected judge, and a model call stays outside the
// steps: they take a `Judge` and nothing else.
import { MEMORY_NOTE_MAX_CHARS } from "@repo/db/shared";

/** One model call: the prompt, then the system text. `null` means the model gave nothing. */
export type Judge = (prompt: string, system: string) => Promise<string | null>;

/**
 * Below this confidence a judge verdict is never applied on its own. The Brain
 * downgrades a low-confidence merge to a human review (`AUTO_MERGE_FLOOR` in its
 * apply.ts). Here a low-confidence merge is not made, and a low-confidence
 * conflict becomes a question.
 */
export const AUTO_APPLY_FLOOR = 0.7;

const TRAILING_DOT = /\.+$/;
const WHITESPACE_RUN = /\s+/g;

/**
 * The strings worth trying `JSON.parse` on: the raw text, then the first brace
 * to the last brace (recovers an object wrapped in prose or cut off after it).
 */
export const extractJsonCandidates = (text: string): string[] => {
  const candidates = [text];
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) {
    candidates.push(text.slice(first, last + 1));
  }
  return candidates;
};

/** A model-supplied confidence as a number in 0 to 1. Anything else is 0. */
export const clampConfidence = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Ask the judge and parse its answer as one JSON object. Never throws: a judge
 * that throws, answers `null` or answers something that is not a JSON object
 * gives `null`, and the step makes no change for that question.
 */
export const askJudge = async (
  judge: Judge,
  prompt: string,
  system: string
): Promise<Record<string, unknown> | null> => {
  let raw: string | null;
  try {
    raw = await judge(prompt, system);
  } catch {
    return null;
  }
  if (raw === null) {
    return null;
  }
  for (const candidate of extractJsonCandidates(raw)) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed)) {
        return parsed;
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
};

/**
 * Note text as the memory file holds it: one line, single spaces, trimmed,
 * 1 to `MEMORY_NOTE_MAX_CHARS` characters. `null` for anything else, so a
 * model's text that would not parse back is never proposed.
 */
export const oneLine = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.replace(WHITESPACE_RUN, " ").trim();
  return text.length > 0 && text.length <= MEMORY_NOTE_MAX_CHARS ? text : null;
};

/** The text compared for an exact duplicate: no case, no extra spaces, no closing full stop. */
export const normalizeText = (text: string): string =>
  text
    .replace(WHITESPACE_RUN, " ")
    .trim()
    .toLowerCase()
    .replace(TRAILING_DOT, "");

/** The strings in `value` that are in `valid`, each once, in the order given. */
export const idsFrom = (
  value: unknown,
  valid: ReadonlySet<string>
): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item === "string" && valid.has(item)) {
      seen.add(item);
    }
  }
  return [...seen];
};
