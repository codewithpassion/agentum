import { z } from "zod";
// The daemon's HTTP client for the run routes under
// `/api/machines/runs/<runId>`: claim, events, heartbeat and complete, and the
// two request routes (raise a request, wait for its outcome). Each JSON body is masked before it is sent, and
// each error message is masked before it is thrown, so the machine credential
// and any secret a run carries never leave the machine in a request or a log.

import {
  type ClaimResponse,
  type CompleteRequest,
  type CreateRequestBody,
  type CreateRequestResponse,
  claimResponseSchema,
  createRequestResponseSchema,
  DAEMON_FEATURES_HEADER,
  type RunEventInput,
  type WaitRequestResponse,
  waitRequestResponseSchema,
} from "@repo/protocol/machine";
import type { Masker } from "@repo/protocol/masker";
import { DAEMON_FEATURES } from "./version.ts";

const CONFLICT = 409;
/** The status a RunApiError carries when no HTTP answer was usable. */
const NO_ANSWER = 0;
/** The status of an answer the Worker sent that this daemon cannot read. Not 0 or 5xx, so a caller that retries on those does not retry it. */
export const UNREADABLE_ANSWER = 422;
const ERROR_TEXT_LIMIT = 200;
const CREDENTIAL_PLACEHOLDER = "[secret:machine_credential]";
const TRAILING_SLASHES = /\/+$/;

/** How long one call to the Worker may take. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** Seconds the Worker holds one wait for a request's outcome. It stays under REQUEST_TIMEOUT_MS. */
export const REQUEST_WAIT_SECONDS = 25;

export class RunApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RunApiError";
    this.status = status;
  }
}

export interface RunApi {
  /** Throws RunApiError on a non-2xx answer or an answer that fails claimResponseSchema. */
  claim: () => Promise<ClaimResponse>;
  /** Throws RunApiError, except that a 409 on `{ status: "aborted" }` resolves: the run already ended, and an aborted completion is accepted once. */
  complete: (body: CompleteRequest) => Promise<void>;
  /** Raises a request. Throws RunApiError on a non-2xx answer or one that fails the protocol. `signal` ends the call early. */
  createRequest: (
    body: CreateRequestBody,
    signal?: AbortSignal
  ) => Promise<CreateRequestResponse>;
  /** Throws RunApiError on a non-2xx answer. */
  events: (events: RunEventInput[]) => Promise<void>;
  heartbeat: () => Promise<void>;
  needsApproval?: (toolKey: string, signal?: AbortSignal) => Promise<boolean>;
  /** One long poll (up to REQUEST_WAIT_SECONDS) for a request's outcome; `status` stays "pending" when none came. Throws like createRequest. */
  waitRequest: (
    requestId: string,
    signal?: AbortSignal
  ) => Promise<WaitRequestResponse>;
}

export interface RunApiOptions {
  /** The machine credential, `hm_mach_...`. */
  credential: string;
  fetch: typeof fetch;
  masker: Masker;
  runId: string;
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

/** The `error` string of a JSON answer, or undefined for any other body. */
const errorField = (text: string): string | undefined => {
  const value = parseJson(text);
  return typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "string"
    ? value.error
    : undefined;
};

/** Built outside a catch block, so the cause is passed on in one place. */
const noAnswerError = (message: string, cause: unknown): RunApiError =>
  new RunApiError(message, NO_ANSWER, { cause });

export const createRunApi = (options: RunApiOptions): RunApi => {
  const { credential, masker, runId } = options;
  const doFetch = options.fetch;
  const base = `${options.server.replace(TRAILING_SLASHES, "")}/api/machines/runs/${encodeURIComponent(runId)}`;

  // Masks, then removes the credential itself, so a server that echoes the
  // credential back cannot put it in an error message.
  const scrub = (text: string): string => {
    const masked = masker.mask(text);
    return credential === ""
      ? masked
      : masked.split(credential).join(CREDENTIAL_PLACEHOLDER);
  };

  const send = async (
    route: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
    call: { method?: string; signal?: AbortSignal } = {}
  ): Promise<Response> => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${credential}`,
      ...extraHeaders,
    };
    // A relay that never answers must not hold a run's slot, or the daemon's
    // shutdown, for longer than this.
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const init: RequestInit = {
      headers,
      method: call.method ?? "POST",
      signal:
        call.signal === undefined
          ? timeout
          : AbortSignal.any([timeout, call.signal]),
    };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(masker.maskDeep(body));
    }
    try {
      return await doFetch(`${base}/${route}`, init);
    } catch (error) {
      throw noAnswerError(
        scrub(`run ${route} request failed before an answer`),
        error
      );
    }
  };

  const failure = async (
    route: string,
    response: Response
  ): Promise<RunApiError> => {
    const text = await response.text().catch(() => "");
    const error = errorField(text);
    const detail =
      error === undefined ? "" : `: ${scrub(error).slice(0, ERROR_TEXT_LIMIT)}`;
    return new RunApiError(
      scrub(`run ${route} answered HTTP ${response.status}${detail}`),
      response.status
    );
  };

  const expectOk = async (route: string, response: Response): Promise<void> => {
    if (!response.ok) {
      throw await failure(route, response);
    }
  };

  const claim = async (): Promise<ClaimResponse> => {
    // Tells the Worker which optional parts of the claim this daemon can read.
    const response = await send("claim", undefined, {
      [DAEMON_FEATURES_HEADER]: DAEMON_FEATURES.join(","),
    });
    await expectOk("claim", response);
    const parsed = claimResponseSchema.safeParse(
      parseJson(await response.text())
    );
    if (!parsed.success) {
      throw new RunApiError(
        scrub("run claim answer does not match the protocol"),
        NO_ANSWER,
        { cause: parsed.error }
      );
    }
    return parsed.data;
  };

  const events = async (runEvents: RunEventInput[]): Promise<void> => {
    await expectOk("events", await send("events", { events: runEvents }));
  };

  const heartbeat = async (): Promise<void> => {
    await expectOk("heartbeat", await send("heartbeat"));
  };

  /** The answer parsed with `schema`, or a RunApiError when it does not match. */
  const parseAnswer = async <T>(
    route: string,
    response: Response,
    schema: { safeParse: (value: unknown) => { data?: T; success: boolean } }
  ): Promise<T> => {
    await expectOk(route, response);
    const parsed = schema.safeParse(parseJson(await response.text()));
    if (!(parsed.success && parsed.data !== undefined)) {
      throw new RunApiError(
        scrub(`run ${route} answer does not match the protocol`),
        UNREADABLE_ANSWER
      );
    }
    return parsed.data;
  };

  const createRequest = async (
    body: CreateRequestBody,
    signal?: AbortSignal
  ): Promise<CreateRequestResponse> =>
    parseAnswer(
      "requests",
      await send("requests", body, {}, { signal }),
      createRequestResponseSchema
    );

  const waitRequest = async (
    requestId: string,
    signal?: AbortSignal
  ): Promise<WaitRequestResponse> =>
    parseAnswer(
      "request wait",
      await send(
        `requests/${encodeURIComponent(requestId)}?wait=${REQUEST_WAIT_SECONDS}`,
        undefined,
        {},
        { method: "GET", signal }
      ),
      waitRequestResponseSchema
    );

  const complete = async (body: CompleteRequest): Promise<void> => {
    const response = await send("complete", body);
    if (response.status === CONFLICT && body.status === "aborted") {
      return;
    }
    await expectOk("complete", response);
  };

  const needsApproval = async (toolKey: string, signal?: AbortSignal) =>
    (
      await parseAnswer(
        "needs-approval",
        await send("needs-approval", { toolKey }, {}, { signal }),
        z.strictObject({ required: z.boolean() })
      )
    ).required;
  return {
    claim,
    complete,
    createRequest,
    events,
    heartbeat,
    needsApproval,
    waitRequest,
  };
};
