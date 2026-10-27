/** Canonicalize validated effect data before the server signs its binding. */
export const canonicalEffect = (value: unknown): string => {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      return input.map(normalize);
    }
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input)
          .filter(([, v]) => v !== undefined)
          .map(([key, v]) => [key, normalize(v)])
          .sort(([a], [b]) => String(a).localeCompare(String(b)))
      );
    }
    return input;
  };
  return JSON.stringify(normalize(value));
};

import type { RequestOutcome } from "@repo/protocol/requests";
export const approvedDecision = (value: RequestOutcome | null) =>
  Boolean(
    value?.status === "answered" &&
      "decision" in value.answer &&
      ["allow_once", "always_allow"].includes(value.answer.decision)
  );
export const matchesEffectApproval = (
  row: { toolUseId: string; display: string; answer: string | null },
  binding: string
) => {
  if (row.toolUseId.startsWith("consumed:") || !row.answer) {
    return false;
  }
  const decision = JSON.parse(row.answer) as { decision?: string };
  const display = JSON.parse(row.display) as { effectBinding?: string };
  return (
    ["allow_once", "always_allow"].includes(decision.decision ?? "") &&
    display.effectBinding === binding
  );
};
