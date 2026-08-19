const UNIQUE_CONSTRAINT = "UNIQUE constraint failed";
const MAX_CAUSE_DEPTH = 5;

/**
 * Drizzle wraps D1 failures in a `DrizzleQueryError` whose message is the SQL;
 * the SQLite constraint text only appears further down the `cause` chain.
 */
export const isUniqueConstraintError = (error: unknown): boolean => {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof Error)) {
      return false;
    }
    if (current.message.includes(UNIQUE_CONSTRAINT)) {
      return true;
    }
    current = current.cause;
  }
  return false;
};
