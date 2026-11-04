/**
 * Argument limits a version declares per tool (`agentum.json` `limits`).
 *
 * B.4 stores them as a tool grant whose target is `<tool>#<canonical json>`.
 * A call is checked against every such row of its version before the tool
 * runs. The check fails closed, and a reason names an argument, never a value.
 */
import type { Database } from "@repo/db";
import { toolLimitRows } from "@repo/db/artifact-calls";
import type { ArgLimit } from "./manifest.ts";

const SEPARATOR = "#";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isScalar = (value: unknown): value is string | number | boolean =>
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean";

const isLimit = (value: unknown): value is ArgLimit =>
  isRecord(value) &&
  Object.entries(value).every(([key, bound]) => {
    switch (key) {
      case "enum":
        return Array.isArray(bound) && bound.every(isScalar);
      case "max":
      case "maxLength":
      case "min":
        return typeof bound === "number" && Number.isFinite(bound);
      default:
        return false;
    }
  });

const parseLimits = (target: string): Record<string, ArgLimit> | null => {
  try {
    const parsed: unknown = JSON.parse(
      target.slice(target.indexOf(SEPARATOR) + 1)
    );
    return isRecord(parsed) && Object.values(parsed).every(isLimit)
      ? (parsed as Record<string, ArgLimit>)
      : null;
  } catch {
    return null;
  }
};

const violation = (
  name: string,
  value: unknown,
  limit: ArgLimit
): string | null => {
  if (limit.enum !== undefined && !limit.enum.includes(value as never)) {
    return `Argument "${name}" is not an allowed value.`;
  }
  if (limit.max !== undefined || limit.min !== undefined) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return `Argument "${name}" must be a number.`;
    }
    if (limit.max !== undefined && value > limit.max) {
      return `Argument "${name}" is above its limit.`;
    }
    if (limit.min !== undefined && value < limit.min) {
      return `Argument "${name}" is below its limit.`;
    }
  }
  if (limit.maxLength !== undefined) {
    if (typeof value !== "string") {
      return `Argument "${name}" must be text.`;
    }
    if (value.length > limit.maxLength) {
      return `Argument "${name}" is too long.`;
    }
  }
  return null;
};

/**
 * Null when `args` satisfy every `<tool>#<json>` target, else a short reason.
 * A limited argument must be present. Arguments without a limit pass.
 */
export const checkArgLimits = (
  args: unknown,
  limitTargets: readonly string[]
): string | null => {
  for (const target of limitTargets) {
    const limits = parseLimits(target);
    if (!limits) {
      return "The argument limits for this tool are not readable.";
    }
    for (const [name, limit] of Object.entries(limits)) {
      if (!(isRecord(args) && Object.hasOwn(args, name))) {
        return `Argument "${name}" is required.`;
      }
      const reason = violation(name, args[name], limit);
      if (reason) {
        return reason;
      }
    }
  }
  return null;
};

/** Checks a call against the limit rows its version holds for `tool`. */
export const checkToolLimits = async (
  db: Database,
  query: {
    args: unknown;
    tool: string;
    versionId: string;
    workspaceId: string;
  }
): Promise<string | null> => {
  const rows = await toolLimitRows(db, query);
  if (rows.some(({ status }) => status !== "approved")) {
    return "The argument limits for this tool are not approved.";
  }
  return checkArgLimits(
    query.args,
    rows.map(({ target }) => target)
  );
};
