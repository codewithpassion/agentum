// The daemon's HTTP client for an agent's skills on the Worker. It authenticates
// with the run token, never the machine credential. File bodies come back
// untouched; only error text is masked, so a secret that an error answer
// carries never reaches a thrown message or a log.

import {
  type SkillFile,
  skillsListResponseSchema,
} from "@repo/protocol/skills";
import type { Masker } from "./masker.ts";
import { RunApiError } from "./run-api.ts";

/** The status a RunApiError carries when no HTTP answer was usable. */
const NO_ANSWER = 0;
const ERROR_TEXT_LIMIT = 200;
const RUN_TOKEN_PLACEHOLDER = "[secret:run_token]";
const TRAILING_SLASHES = /\/+$/;

/** How long one skills request may take. */
export const SKILLS_REQUEST_TIMEOUT_MS = 120_000;

export interface SkillsApi {
  /** GET <server>/api/runs/<runId>/skills/file?path=<path>, same bearer. Resolves with the body bytes. Throws RunApiError on a non-2xx answer. */
  file: (path: string, signal?: AbortSignal) => Promise<Uint8Array>;
  /** GET <server>/api/runs/<runId>/skills with `Authorization: Bearer <runToken>`. Throws RunApiError on a non-2xx answer or an answer that fails skillsListResponseSchema. */
  list: (signal?: AbortSignal) => Promise<SkillFile[]>;
}

export interface SkillsApiOptions {
  fetch: typeof fetch;
  masker: Masker;
  runId: string;
  /** The run token, `hm_run_...`. */
  runToken: string;
  /** Worker origin; trailing slashes are tolerated. */
  server: string;
}

/** The parsed body, or null when the body is not JSON. */
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** Built outside a catch block, so the cause is passed on in one place. */
const noAnswerError = (message: string, cause: unknown): RunApiError =>
  new RunApiError(message, NO_ANSWER, { cause });

/** The string under `key` of a JSON object answer, or undefined for any other body. */
const stringField = (text: string, key: string): string | undefined => {
  const value = parseJson(text);
  if (typeof value !== "object" || value === null || !(key in value)) {
    return;
  }
  const field = value[key as keyof typeof value];
  return typeof field === "string" ? field : undefined;
};

export const createSkillsApi = (options: SkillsApiOptions): SkillsApi => {
  const { masker, runToken } = options;
  const doFetch = options.fetch;
  const base = `${options.server.replace(TRAILING_SLASHES, "")}/api/runs/${encodeURIComponent(options.runId)}/skills`;
  const authorization = `Bearer ${runToken}`;

  // Masks, then removes the run token itself, so a server that echoes the
  // token back cannot put it in an error message.
  const scrub = (text: string): string => {
    const masked = masker.mask(text);
    return runToken === ""
      ? masked
      : masked.split(runToken).join(RUN_TOKEN_PLACEHOLDER);
  };

  const requestSignal = (signal?: AbortSignal): AbortSignal => {
    const timeout = AbortSignal.timeout(SKILLS_REQUEST_TIMEOUT_MS);
    return signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
  };

  const send = async (
    route: string,
    url: string,
    signal?: AbortSignal
  ): Promise<Response> => {
    try {
      return await doFetch(url, {
        headers: { authorization },
        method: "GET",
        signal: requestSignal(signal),
      });
    } catch (error) {
      throw noAnswerError(
        scrub(`skills ${route} request failed before an answer`),
        error
      );
    }
  };

  const failure = async (
    route: string,
    response: Response
  ): Promise<RunApiError> => {
    const text = await response.text().catch(() => "");
    const error = stringField(text, "error");
    const detail =
      error === undefined ? "" : `: ${scrub(error).slice(0, ERROR_TEXT_LIMIT)}`;
    return new RunApiError(
      scrub(`skills ${route} answered HTTP ${response.status}${detail}`),
      response.status
    );
  };

  const list = async (signal?: AbortSignal): Promise<SkillFile[]> => {
    const response = await send("list", base, signal);
    if (!response.ok) {
      throw await failure("list", response);
    }
    const parsed = skillsListResponseSchema.safeParse(
      parseJson(await response.text().catch(() => ""))
    );
    if (!parsed.success) {
      throw new RunApiError(
        scrub("skills list answer does not match the protocol"),
        NO_ANSWER
      );
    }
    return parsed.data.files;
  };

  const file = async (
    path: string,
    signal?: AbortSignal
  ): Promise<Uint8Array> => {
    const response = await send(
      "file",
      `${base}/file?path=${encodeURIComponent(path)}`,
      signal
    );
    if (!response.ok) {
      throw await failure("file", response);
    }
    try {
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      throw noAnswerError(scrub("skills file answer could not be read"), error);
    }
  };

  return { file, list };
};
