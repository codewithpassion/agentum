/**
 * An app's `agentum.json`: the tools it asks for, the hosts it may reach
 * and the secrets it may read. Pure functions over plain text: no database and
 * no I/O, so the caller reads the version's files and passes them in.
 */

import { z } from "zod";
import { ServiceError } from "../errors.ts";

export const MANIFEST_PATH = "agentum.json";
export const SERVER_DIR = "server/";

const MAX_TOOLS = 50;
const MAX_HOSTS = 20;
const MAX_SECRETS = 20;
const MAX_ENUM = 50;
const MAX_ARG_NAME = 64;
const MAX_HOST_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;

const TOOL_PATTERN = /^[A-Za-z0-9_.-]{1,64}\/[A-Za-z0-9_.-]{1,128}$/;
const HOST_LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const SECRET_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ALL_DIGITS_PATTERN = /^[0-9]+$/;
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal"] as const;

export interface ArgLimit {
  enum?: (string | number | boolean)[];
  max?: number;
  maxLength?: number;
  min?: number;
}

export interface ManifestTool {
  limits?: Record<string, ArgLimit>;
  tool: string;
}

export interface AppManifest {
  agents: { agent: string }[];
  endpoints: { name: string }[];
  hosts: string[];
  secrets: string[];
  tools: ManifestTool[];
}

export interface DeclaredGrant {
  kind: "tool" | "secret" | "host" | "endpoint" | "agent";
  target: string;
}

export const emptyManifest = (): AppManifest => ({
  agents: [],
  endpoints: [],
  hosts: [],
  secrets: [],
  tools: [],
});

/** Why a host name is refused, or null when it may be declared. */
const hostProblem = (host: string): string | null => {
  if (host.length > MAX_HOST_LENGTH) {
    return `host is longer than ${MAX_HOST_LENGTH} characters`;
  }
  const labels = host.split(".");
  if (labels.length < 2) {
    return "host needs at least one dot";
  }
  if (!labels.every((label) => label.length <= MAX_LABEL_LENGTH)) {
    return `host labels are at most ${MAX_LABEL_LENGTH} characters`;
  }
  if (!labels.every((label) => HOST_LABEL_PATTERN.test(label))) {
    return "host must be lower-case letters, digits and hyphens, with no scheme, port, path or wildcard";
  }
  if (ALL_DIGITS_PATTERN.test(labels.at(-1) ?? "")) {
    return "host must not be an IP address";
  }
  if (host === "localhost" || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) {
    return "host must not be a local name";
  }
  return null;
};

const argLimitSchema = z
  .strictObject({
    enum: z
      .array(z.union([z.string(), z.number(), z.boolean()]))
      .min(1)
      .max(MAX_ENUM)
      .optional(),
    max: z.number().optional(),
    maxLength: z.number().int().min(0).optional(),
    min: z.number().optional(),
  })
  .refine((limit) => Object.values(limit).some((v) => v !== undefined), {
    message: "a limit needs at least one of enum, max, maxLength or min",
  });

const toolSchema = z.strictObject({
  limits: z
    .record(z.string().min(1).max(MAX_ARG_NAME), argLimitSchema)
    .optional(),
  tool: z.string().regex(TOOL_PATTERN, "tool must be <serverKey>/<name>"),
});

const hostSchema = z.string().superRefine((host, ctx) => {
  const problem = hostProblem(host);
  if (problem !== null) {
    ctx.addIssue({ code: "custom", message: problem });
  }
});

const secretSchema = z
  .string()
  .regex(SECRET_PATTERN, "secret must be a name like API_KEY");

const manifestSchema = z.strictObject({
  // Agent ids follow the run input id convention; existence belongs to the later hand-off service.
  agents: z
    .array(z.strictObject({ agent: z.string().min(1).max(200) }))
    .max(5)
    .default([]),
  endpoints: z
    .array(z.strictObject({ name: z.string().regex(/^[a-z0-9-]{1,40}$/) }))
    .max(5)
    .default([]),
  hosts: z.array(hostSchema).max(MAX_HOSTS).default([]),
  secrets: z.array(secretSchema).max(MAX_SECRETS).default([]),
  tools: z.array(toolSchema).max(MAX_TOOLS).default([]),
});

const invalid = (detail: string): ServiceError =>
  new ServiceError("invalid", `${MANIFEST_PATH}: ${detail}`);

const parseText = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    // biome-ignore lint/style/useErrorCause: ServiceError takes no cause, and the parser's message is not useful to the caller
    throw invalid("is not valid JSON");
  }
};

const validateShape = (json: unknown): AppManifest => {
  const result = manifestSchema.safeParse(json);
  if (result.success) {
    return result.data;
  }
  const issue = result.error.issues.at(0);
  if (issue === undefined) {
    throw invalid("does not match the schema");
  }
  const path = issue.path.map(String).join(".");
  throw invalid(path === "" ? issue.message : `${path}: ${issue.message}`);
};

const firstDuplicate = (values: readonly string[]): string | null => {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      return value;
    }
    seen.add(value);
  }
  return null;
};

/**
 * Reads the manifest out of an app version's files. A version with no root
 * `agentum.json` declares nothing. Every other failure throws
 * `ServiceError("invalid")`.
 */
export const parseManifest = (
  files: readonly { path: string; text?: string }[]
): AppManifest => {
  const file = files.find((candidate) => candidate.path === MANIFEST_PATH);
  if (file === undefined) {
    return emptyManifest();
  }
  if (file.text === undefined) {
    throw invalid("has no text to read");
  }

  const manifest = validateShape(parseText(file.text));

  const duplicateTool = firstDuplicate(manifest.tools.map((t) => t.tool));
  if (duplicateTool !== null) {
    throw invalid(`tool "${duplicateTool}" is declared twice`);
  }
  const duplicateHost = firstDuplicate(manifest.hosts);
  if (duplicateHost !== null) {
    throw invalid(`host "${duplicateHost}" is declared twice`);
  }
  const duplicateSecret = firstDuplicate(manifest.secrets);
  if (duplicateSecret !== null) {
    throw invalid(`secret "${duplicateSecret}" is declared twice`);
  }

  for (const [kind, values] of [
    ["endpoint", manifest.endpoints.map((entry) => entry.name)],
    ["agent", manifest.agents.map((entry) => entry.agent)],
  ] as const) {
    const duplicate = firstDuplicate(values);
    if (duplicate !== null) {
      throw invalid(`${kind} "${duplicate}" is declared twice`);
    }
  }
  const needsServer =
    manifest.hosts.length > 0 ||
    manifest.secrets.length > 0 ||
    manifest.endpoints.length > 0 ||
    manifest.agents.length > 0;
  if (needsServer && !files.some((f) => f.path.startsWith(SERVER_DIR))) {
    throw invalid(
      `hosts, secrets, endpoints and agents need a ${SERVER_DIR} part`
    );
  }

  return manifest;
};

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortKeys(record[key])])
    );
  }
  return value;
};

/** JSON with object keys sorted at every depth. Array order is kept. */
export const canonicalJson = (value: unknown): string =>
  JSON.stringify(sortKeys(value));

const compareText = (a: string, b: string): number => {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};

/**
 * The grants an app asks for, sorted by kind then target. A tool with limits
 * adds a second grant whose target pins the exact limits.
 */
export const declaredGrants = (manifest: AppManifest): DeclaredGrant[] => {
  const grants: DeclaredGrant[] = [];
  for (const { agent } of manifest.agents) {
    grants.push({ kind: "agent", target: agent });
  }
  for (const { name } of manifest.endpoints) {
    grants.push({ kind: "endpoint", target: name });
  }
  for (const { tool, limits } of manifest.tools) {
    grants.push({ kind: "tool", target: tool });
    if (limits !== undefined && Object.keys(limits).length > 0) {
      grants.push({ kind: "tool", target: `${tool}#${canonicalJson(limits)}` });
    }
  }
  for (const host of manifest.hosts) {
    grants.push({ kind: "host", target: host });
  }
  for (const secret of manifest.secrets) {
    grants.push({ kind: "secret", target: secret });
  }

  grants.sort(
    (a, b) => compareText(a.kind, b.kind) || compareText(a.target, b.target)
  );
  return grants.filter(
    (grant, index) =>
      index === 0 ||
      grant.kind !== grants[index - 1]?.kind ||
      grant.target !== grants[index - 1]?.target
  );
};
