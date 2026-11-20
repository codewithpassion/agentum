/** Reported USD, or null when usage is missing, malformed or has no finite `costUsd`. */
export const reportedCostOf = (raw: string | null): number | null => {
  let usage: unknown = null;
  try {
    usage = raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
  if (
    usage &&
    typeof usage === "object" &&
    "costUsd" in usage &&
    typeof usage.costUsd === "number" &&
    Number.isFinite(usage.costUsd)
  ) {
    return usage.costUsd;
  }
  return null;
};

/** Reported USD only; missing, malformed and non-finite costs contribute zero. */
export const costOf = (raw: string | null): number => reportedCostOf(raw) ?? 0;
