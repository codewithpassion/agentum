/**
 * Reported by `ping` and `/healthz`. Kept as a constant rather than read from
 * package.json so the container image needs nothing but `src/`; `version.test.ts`
 * fails if the two ever drift.
 */
export const VERSION = "0.1.0";
