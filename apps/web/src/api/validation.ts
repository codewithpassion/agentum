import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

const BAD_REQUEST = 400;
const NOT_FOUND = 404;

/** `/api` speaks JSON, including on the error paths. */
const httpError = (
  status: ContentfulStatusCode,
  message: string,
  cause?: unknown
): HTTPException =>
  new HTTPException(status, {
    cause,
    message,
    res: Response.json({ error: message }, { status }),
  });

export const badRequest = (message: string, cause?: unknown): HTTPException =>
  httpError(BAD_REQUEST, message, cause);

export const notFound = (message: string): HTTPException =>
  httpError(NOT_FOUND, message);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Parses a JSON request body, rejecting anything that is not an object. */
export const readJsonObject = async (
  request: Request
): Promise<Record<string, unknown>> => {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch (error) {
    throw badRequest("Expected a JSON body.", error);
  }
  if (!isRecord(parsed)) {
    throw badRequest("Expected a JSON object.");
  }
  return parsed;
};

export const requireString = (
  body: Record<string, unknown>,
  field: string,
  { maxLength = 10_000 }: { maxLength?: number } = {}
): string => {
  const value = body[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw badRequest(`"${field}" is required.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw badRequest(`"${field}" must be at most ${maxLength} characters.`);
  }
  return trimmed;
};

/** Unlike `requireString`, an empty string is a valid value here: it clears a field. */
export const optionalString = (
  body: Record<string, unknown>,
  field: string,
  { maxLength = 10_000 }: { maxLength?: number } = {}
): string | undefined => {
  const value = body[field];
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value !== "string") {
    throw badRequest(`"${field}" must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw badRequest(`"${field}" must be at most ${maxLength} characters.`);
  }
  return trimmed;
};

export const optionalStringArray = (
  body: Record<string, unknown>,
  field: string
): string[] | undefined => {
  const value = body[field];
  if (value === undefined || value === null) {
    return;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw badRequest(`"${field}" must be an array of strings.`);
  }
  return value as string[];
};

export const optionalBoolean = (
  body: Record<string, unknown>,
  field: string
): boolean => {
  const value = body[field];
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value !== "boolean") {
    throw badRequest(`"${field}" must be a boolean.`);
  }
  return value;
};

export const requireEnum = <const T extends readonly string[]>(
  body: Record<string, unknown>,
  field: string,
  allowed: T
): T[number] => {
  const value = body[field];
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw badRequest(`"${field}" must be one of: ${allowed.join(", ")}.`);
  }
  return value;
};

export const parsePositiveInt = (
  raw: string | undefined,
  { fallback, max }: { fallback: number; max: number }
): number => {
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw badRequest("Expected a positive integer.");
  }
  return Math.min(parsed, max);
};
