/**
 * What a service refuses with besides `ForbiddenError` (see authz.ts). The
 * `code` maps to an HTTP status in routes and to a tRPC code in routers.
 */
export type ServiceErrorCode = "conflict" | "invalid" | "not_found";

const STATUS: Record<ServiceErrorCode, number> = {
  conflict: 409,
  invalid: 400,
  not_found: 404,
};

/**
 * Why a refusal happened, for a client that must act on it. Clients read this
 * and never match the wording of the message.
 */
export const ERROR_REASON = {
  keyInMessage: "key_in_message",
} as const;

export type ErrorReason = (typeof ERROR_REASON)[keyof typeof ERROR_REASON];

export class ServiceError extends Error {
  override readonly name = "ServiceError";
  readonly code: ServiceErrorCode;
  readonly reason: ErrorReason | null;
  readonly status: number;

  constructor(
    code: ServiceErrorCode,
    message: string,
    reason: ErrorReason | null = null
  ) {
    super(message);
    this.code = code;
    this.reason = reason;
    this.status = STATUS[code];
  }
}

/** A request the caller must fix: 400. */
export const invalid = (message: string): ServiceError =>
  new ServiceError("invalid", message);

/** Missing, or not visible to the caller: 404. */
export const notFound = (message = "Not found"): ServiceError =>
  new ServiceError("not_found", message);

export const isServiceError = (error: unknown): error is ServiceError =>
  error instanceof ServiceError;

const UNIQUE_MESSAGE = "UNIQUE constraint failed";
const MAX_CAUSE_DEPTH = 5;

/**
 * Whether a write failed on a unique index. bun:sqlite throws it directly;
 * D1 and drizzle wrap it, so the message is looked for down the `cause` chain.
 */
export const isUniqueViolation = (error: unknown): boolean => {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof Error)) {
      return false;
    }
    if (current.message.includes(UNIQUE_MESSAGE)) {
      return true;
    }
    current = current.cause;
  }
  return false;
};
