/** Reported USD only; missing, malformed and non-finite costs contribute zero. */
export const costOf = (raw: string | null): number => {
  let usage: unknown = null;
  try {
    usage = raw ? JSON.parse(raw) : null;
  } catch {
    return 0;
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
  return 0;
};
