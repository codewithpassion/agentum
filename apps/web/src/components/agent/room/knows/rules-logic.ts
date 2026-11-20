import type { LearnLevel } from "@repo/db/shared";

export const MAX_RULE_ENTRIES = 50;
export const MAX_RULE_CHARS = 200;

export interface RuleRow {
  /** True for a workspace rule, which the agent cannot remove. */
  locked: boolean;
  text: string;
}

const ruleKey = (text: string): string => text.trim().toLowerCase();

/** Workspace rules first, all locked, then the agent's own, unlocked. An agent rule that repeats a workspace rule (compare trimmed, case-insensitive) is left out. */
export function neverRows(
  workspaceNever: readonly string[],
  agentNever: readonly string[]
): RuleRow[] {
  const workspaceKeys = new Set(workspaceNever.map(ruleKey));
  const workspaceRows = workspaceNever.map((text) => ({ locked: true, text }));
  const agentRows = agentNever
    .filter((text) => !workspaceKeys.has(ruleKey(text)))
    .map((text) => ({ locked: false, text }));
  return [...workspaceRows, ...agentRows];
}

/** True for an org admin, or when userId equals ownerUserId. False when userId is null and the caller is not an admin. */
export function canChangeRules(input: {
  isAdmin: boolean;
  ownerUserId: string | null;
  userId: string | null;
}): boolean {
  if (input.isAdmin) {
    return true;
  }
  return input.userId !== null && input.userId === input.ownerUserId;
}

/** The list with `text` added, or null when it is empty after trimming, longer than MAX_RULE_CHARS, repeats an entry (trimmed, case-insensitive) or the list already has MAX_RULE_ENTRIES. Never mutates. */
export function addRule(
  list: readonly string[],
  text: string
): string[] | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_RULE_CHARS) {
    return null;
  }
  if (list.length >= MAX_RULE_ENTRIES) {
    return null;
  }
  const key = ruleKey(trimmed);
  if (list.some((entry) => ruleKey(entry) === key)) {
    return null;
  }
  return [...list, trimmed];
}

/** The list without the entry equal to `text` (exact match). Never mutates. */
export function removeRule(list: readonly string[], text: string): string[] {
  return list.filter((entry) => entry !== text);
}

export const LEARN_LEVEL_OPTIONS: readonly {
  hint: string;
  label: string;
  value: LearnLevel;
}[] = [
  {
    hint: "Every new note waits for your approval.",
    label: "Ask me first",
    value: "ask_first",
  },
  {
    hint: "Notes apply at once and show under Learned this week.",
    label: "Tell me after",
    value: "tell_after",
  },
  {
    hint: "Notes apply at once and show only in the dream diary.",
    label: "Quietly",
    value: "quiet",
  },
];
