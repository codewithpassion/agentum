// Tests for the run API client: the run routes and the request routes, their URLs and bearer header,
// the masking of bodies and errors, and the status each failure carries.
import { describe, expect, test } from "bun:test";
import type {
  CompleteRequest,
  CreateRequestBody,
  CreateRequestResponse,
  RunEventInput,
  WaitRequestResponse,
} from "@repo/protocol/machine";
import { createMasker } from "@repo/protocol/masker";
import { file } from "bun";
import { createRunApi, RunApiError } from "./run-api.ts";

const CREDENTIAL = "hm_mach_credential_for_tests_0123456789";
const SECRET = "sk-live-do-not-leak";
const RUN_ID = "01HZXA3N5P7Q9R1S3T5V7W9X1Y";
const SERVER = "https://harbourmaster.example.workers.dev";
const RUN_BASE = `${SERVER}/api/machines/runs/${RUN_ID}`;
const ERROR_TEXT_LIMIT = 200;
const FORBIDDEN = 403;
const CONFLICT = 409;
const SERVER_ERROR = 500;

interface Call {
  body: unknown;
  headers: Record<string, string>;
  method: string;
  url: string;
}

type Answer = (call: Call) => Response;

const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  });

/** A fake fetch that records every call and answers with `answer`. */
const recordingFetch = (answer: Answer = () => jsonResponse({})) => {
  const calls: Call[] = [];
  const fake = (
    input: Request | URL | string,
    init?: RequestInit
  ): Promise<Response> => {
    const call: Call = {
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      headers: Object.fromEntries(new Headers(init?.headers)),
      method: init?.method ?? "GET",
      url: String(input),
    };
    calls.push(call);
    return Promise.resolve(answer(call));
  };
  return { calls, fetch: Object.assign(fake, { preconnect: () => undefined }) };
};

const makeApi = (
  fetchFn: ReturnType<typeof recordingFetch>["fetch"],
  server = SERVER
) =>
  createRunApi({
    credential: CREDENTIAL,
    fetch: fetchFn,
    masker: createMasker({ api_key: SECRET }),
    runId: RUN_ID,
    server,
  });

const claimFixture = (): Promise<unknown> =>
  file(
    `${import.meta.dir}/../../../packages/protocol/fixtures/claim-response.json`
  ).json();

/** The first request a fake fetch recorded. */
const firstCall = (calls: Call[]): Call => {
  const [call] = calls;
  if (call === undefined) {
    throw new Error("no request was recorded");
  }
  return call;
};

const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to reject");
};

const events: RunEventInput[] = [
  { payload: { text: "hello" }, seq: 1, type: "message.assistant" },
];

describe("URLs and headers", () => {
  test("posts each route to its run URL with the bearer credential", async () => {
    const { calls, fetch } = recordingFetch(() => jsonResponse({}));
    const api = makeApi(fetch);
    await api.heartbeat();
    expect(calls).toHaveLength(1);
    expect(firstCall(calls).url).toBe(`${RUN_BASE}/heartbeat`);
    expect(firstCall(calls).method).toBe("POST");
    expect(firstCall(calls).headers.authorization).toBe(`Bearer ${CREDENTIAL}`);
  });

  test("tolerates trailing slashes on the server origin", async () => {
    const { calls, fetch } = recordingFetch(() => jsonResponse({}));
    await makeApi(fetch, `${SERVER}//`).heartbeat();
    expect(firstCall(calls).url).toBe(`${RUN_BASE}/heartbeat`);
  });

  test("sends no content-type when there is no body", async () => {
    const { calls, fetch } = recordingFetch(() => jsonResponse({}));
    await makeApi(fetch).heartbeat();
    expect(firstCall(calls).headers["content-type"]).toBeUndefined();
    expect(firstCall(calls).body).toBeUndefined();
  });
});

describe("claim", () => {
  test("parses the claim fixture", async () => {
    const fixture = await claimFixture();
    const { calls, fetch } = recordingFetch(() => jsonResponse(fixture));
    const claim = await makeApi(fetch).claim();
    expect(claim).toEqual(fixture as typeof claim);
    expect(firstCall(calls).url).toBe(`${RUN_BASE}/claim`);
  });

  test("tells the Worker it reads the library part of the claim", async () => {
    const fixture = await claimFixture();
    const { calls, fetch } = recordingFetch(() => jsonResponse(fixture));
    await makeApi(fetch).claim();
    expect(firstCall(calls).headers["x-daemon-features"]).toBe(
      "library-sync,requests"
    );
  });

  test("an answer that fails the schema gives status 0", async () => {
    const { fetch } = recordingFetch(() => jsonResponse({ run: {} }));
    const error = await rejectionOf(makeApi(fetch).claim());
    expect(error).toBeInstanceOf(RunApiError);
    expect((error as RunApiError).status).toBe(0);
  });

  test("a non-2xx answer throws with its status", async () => {
    const { fetch } = recordingFetch(() => jsonResponse({}, SERVER_ERROR));
    const error = await rejectionOf(makeApi(fetch).claim());
    expect((error as RunApiError).status).toBe(SERVER_ERROR);
  });
});

describe("events", () => {
  test("sends the events as a JSON body", async () => {
    const { calls, fetch } = recordingFetch(() => jsonResponse({ lastSeq: 1 }));
    await makeApi(fetch).events(events);
    expect(firstCall(calls).url).toBe(`${RUN_BASE}/events`);
    expect(firstCall(calls).headers["content-type"]).toBe("application/json");
    expect(firstCall(calls).headers.authorization).toBe(`Bearer ${CREDENTIAL}`);
    expect(firstCall(calls).body).toEqual({ events });
  });

  test("masks a secret inside an event payload", async () => {
    const { calls, fetch } = recordingFetch(() => jsonResponse({ lastSeq: 1 }));
    await makeApi(fetch).events([
      {
        payload: { nested: [SECRET], output: `key is ${SECRET}` },
        seq: 1,
        type: "tool.result",
      },
    ]);
    expect(firstCall(calls).body).toEqual({
      events: [
        {
          payload: {
            nested: ["[secret:api_key]"],
            output: "key is [secret:api_key]",
          },
          seq: 1,
          type: "tool.result",
        },
      ],
    });
    expect(JSON.stringify(firstCall(calls).body)).not.toContain(SECRET);
  });

  test("a 409 throws with status 409", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({ error: "stale" }, CONFLICT)
    );
    const error = await rejectionOf(makeApi(fetch).events(events));
    expect(error).toBeInstanceOf(RunApiError);
    expect((error as RunApiError).status).toBe(CONFLICT);
  });
});

describe("heartbeat", () => {
  test("posts without a body", async () => {
    const { calls, fetch } = recordingFetch(() => jsonResponse({}));
    await makeApi(fetch).heartbeat();
    expect(firstCall(calls).url).toBe(`${RUN_BASE}/heartbeat`);
    expect(firstCall(calls).method).toBe("POST");
  });
});

describe("complete", () => {
  const done: CompleteRequest = {
    status: "done",
    text: `the answer is ${SECRET}`,
    usage: { inputTokens: 3 },
  };

  test("sends the body, masking a secret inside the text", async () => {
    const { calls, fetch } = recordingFetch(() => jsonResponse({}));
    await makeApi(fetch).complete(done);
    expect(firstCall(calls).url).toBe(`${RUN_BASE}/complete`);
    expect(firstCall(calls).body).toEqual({
      status: "done",
      text: "the answer is [secret:api_key]",
      usage: { inputTokens: 3 },
    });
    expect(JSON.stringify(firstCall(calls).body)).not.toContain(SECRET);
  });

  test("a 409 on an aborted completion resolves", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({ error: "ended" }, CONFLICT)
    );
    await expect(
      makeApi(fetch).complete({ status: "aborted" })
    ).resolves.toBeUndefined();
  });

  test("a 409 on a done completion throws with status 409", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({ error: "ended" }, CONFLICT)
    );
    const error = await rejectionOf(makeApi(fetch).complete(done));
    expect((error as RunApiError).status).toBe(CONFLICT);
  });
});

describe("failures", () => {
  test("a thrown fetch becomes status 0 with the original error as cause", async () => {
    const original = new TypeError("socket hang up");
    const fetch = Object.assign(
      (): Promise<Response> => Promise.reject(original),
      { preconnect: () => undefined }
    );
    const error = await rejectionOf(makeApi(fetch).heartbeat());
    expect(error).toBeInstanceOf(RunApiError);
    expect((error as RunApiError).status).toBe(0);
    expect((error as RunApiError).cause).toBe(original);
  });

  test("an error message never contains the credential, even when echoed", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({ error: `bad credential ${CREDENTIAL}` }, FORBIDDEN)
    );
    const error = await rejectionOf(makeApi(fetch).heartbeat());
    const { message } = error as RunApiError;
    expect(message).not.toContain(CREDENTIAL);
    expect(message).toContain(`${FORBIDDEN}`);
    expect(message).toContain("heartbeat");
  });

  test("the message carries the error field cut to its first 200 characters", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({ error: "x".repeat(ERROR_TEXT_LIMIT + 50) }, FORBIDDEN)
    );
    const { message } = (await rejectionOf(
      makeApi(fetch).heartbeat()
    )) as RunApiError;
    expect(message).toContain("x".repeat(ERROR_TEXT_LIMIT));
    expect(message).not.toContain("x".repeat(ERROR_TEXT_LIMIT + 1));
  });

  test("a non-JSON body is not echoed into the message", async () => {
    const { fetch } = recordingFetch(
      () => new Response("raw body text", { status: SERVER_ERROR })
    );
    const { message } = (await rejectionOf(
      makeApi(fetch).heartbeat()
    )) as RunApiError;
    expect(message).not.toContain("raw body text");
    expect(message).toContain(`${SERVER_ERROR}`);
  });
});

const REQUEST_ID = "req_01HZXA3N5P7Q9R1S3T5V7W9X1Y";
const WAIT_SECONDS = 25;
const REQUESTS_URL = `${RUN_BASE}/requests`;
const REQUEST_URL = `${RUN_BASE}/requests/${REQUEST_ID}?wait=${WAIT_SECONDS}`;

const requestBody: CreateRequestBody = {
  display: {
    input: { command: "ls", token: SECRET },
    summary: "Run `ls`",
    toolKey: "bash",
    toolName: "Bash",
  },
  kind: "approval",
  toolName: "Bash",
  toolUseId: "toolu_1",
};

const answeredOutcome = {
  outcome: { answer: { answers: { Q: "A" } }, status: "answered" },
  status: "answered",
};

/** A fake fetch that rejects with the signal's reason once the signal aborts. */
const abortAwareFetch = () => {
  const signals: AbortSignal[] = [];
  const fake = (
    _input: Request | URL | string,
    init?: RequestInit
  ): Promise<Response> =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal ?? undefined;
      if (signal === undefined) {
        return;
      }
      signals.push(signal);
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  return {
    fetch: Object.assign(fake, { preconnect: () => undefined }),
    signals,
  };
};

describe("createRequest", () => {
  test("posts the body to the requests route with the bearer credential", async () => {
    const { calls, fetch } = recordingFetch(() =>
      jsonResponse({ requestId: REQUEST_ID, status: "pending" })
    );
    await makeApi(fetch).createRequest(requestBody);
    expect(calls).toHaveLength(1);
    expect(firstCall(calls).url).toBe(REQUESTS_URL);
    expect(firstCall(calls).method).toBe("POST");
    expect(firstCall(calls).headers.authorization).toBe(`Bearer ${CREDENTIAL}`);
    expect(firstCall(calls).headers["content-type"]).toBe("application/json");
  });

  test("masks a secret inside the display input", async () => {
    const { calls, fetch } = recordingFetch(() =>
      jsonResponse({ requestId: REQUEST_ID, status: "pending" })
    );
    await makeApi(fetch).createRequest(requestBody);
    expect(firstCall(calls).body).toEqual({
      ...requestBody,
      display: {
        ...requestBody.display,
        input: { command: "ls", token: "[secret:api_key]" },
      },
    });
    expect(JSON.stringify(firstCall(calls).body)).not.toContain(SECRET);
  });

  test("returns the parsed answer", async () => {
    const answer = {
      outcome: { status: "expired" },
      requestId: REQUEST_ID,
      status: "answered",
    };
    const { fetch } = recordingFetch(() => jsonResponse(answer));
    expect(await makeApi(fetch).createRequest(requestBody)).toEqual(
      answer as CreateRequestResponse
    );
  });

  test.each([CONFLICT, SERVER_ERROR])(
    "a %p answer throws with its status",
    async (status) => {
      const { fetch } = recordingFetch(() => jsonResponse({}, status));
      const error = await rejectionOf(
        makeApi(fetch).createRequest(requestBody)
      );
      expect(error).toBeInstanceOf(RunApiError);
      expect((error as RunApiError).status).toBe(status);
    }
  );

  test("an answer that fails the protocol gives status 0", async () => {
    const { fetch } = recordingFetch(() => jsonResponse({}));
    const error = await rejectionOf(makeApi(fetch).createRequest(requestBody));
    expect(error).toBeInstanceOf(RunApiError);
    expect((error as RunApiError).status).toBe(0);
  });

  test("a thrown fetch gives status 0", async () => {
    const original = new TypeError("socket hang up");
    const fetch = Object.assign(
      (): Promise<Response> => Promise.reject(original),
      { preconnect: () => undefined }
    );
    const error = await rejectionOf(makeApi(fetch).createRequest(requestBody));
    expect(error).toBeInstanceOf(RunApiError);
    expect((error as RunApiError).status).toBe(0);
    expect((error as RunApiError).cause).toBe(original);
  });

  test("an aborted signal rejects with status 0 and reaches the fetch aborted", async () => {
    const { fetch, signals } = abortAwareFetch();
    const controller = new AbortController();
    controller.abort();
    const error = await rejectionOf(
      makeApi(fetch).createRequest(requestBody, controller.signal)
    );
    expect(error).toBeInstanceOf(RunApiError);
    expect((error as RunApiError).status).toBe(0);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
  });
});

describe("waitRequest", () => {
  test("gets the request with the wait window, the bearer credential and no body", async () => {
    const { calls, fetch } = recordingFetch(() =>
      jsonResponse({ status: "pending" })
    );
    await makeApi(fetch).waitRequest(REQUEST_ID);
    expect(calls).toHaveLength(1);
    expect(firstCall(calls).url).toBe(REQUEST_URL);
    expect(firstCall(calls).method).toBe("GET");
    expect(firstCall(calls).headers.authorization).toBe(`Bearer ${CREDENTIAL}`);
    expect(firstCall(calls).headers["content-type"]).toBeUndefined();
    expect(firstCall(calls).body).toBeUndefined();
  });

  test("returns a pending status when no outcome came", async () => {
    const { fetch } = recordingFetch(() => jsonResponse({ status: "pending" }));
    expect(await makeApi(fetch).waitRequest(REQUEST_ID)).toEqual({
      status: "pending",
    });
  });

  test("returns an answered outcome", async () => {
    const { fetch } = recordingFetch(() => jsonResponse(answeredOutcome));
    expect(await makeApi(fetch).waitRequest(REQUEST_ID)).toEqual(
      answeredOutcome as WaitRequestResponse
    );
  });

  test.each([CONFLICT, SERVER_ERROR])(
    "a %p answer throws with its status",
    async (status) => {
      const { fetch } = recordingFetch(() => jsonResponse({}, status));
      const error = await rejectionOf(makeApi(fetch).waitRequest(REQUEST_ID));
      expect(error).toBeInstanceOf(RunApiError);
      expect((error as RunApiError).status).toBe(status);
    }
  );

  test("an answer that fails the protocol gives status 0", async () => {
    const { fetch } = recordingFetch(() => jsonResponse({}));
    const error = await rejectionOf(makeApi(fetch).waitRequest(REQUEST_ID));
    expect(error).toBeInstanceOf(RunApiError);
    expect((error as RunApiError).status).toBe(0);
  });

  test("a thrown fetch gives status 0", async () => {
    const original = new TypeError("socket hang up");
    const fetch = Object.assign(
      (): Promise<Response> => Promise.reject(original),
      { preconnect: () => undefined }
    );
    const error = await rejectionOf(makeApi(fetch).waitRequest(REQUEST_ID));
    expect(error).toBeInstanceOf(RunApiError);
    expect((error as RunApiError).status).toBe(0);
    expect((error as RunApiError).cause).toBe(original);
  });

  test("an aborted signal rejects with status 0 and reaches the fetch aborted", async () => {
    const { fetch, signals } = abortAwareFetch();
    const controller = new AbortController();
    controller.abort();
    const error = await rejectionOf(
      makeApi(fetch).waitRequest(REQUEST_ID, controller.signal)
    );
    expect(error).toBeInstanceOf(RunApiError);
    expect((error as RunApiError).status).toBe(0);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
  });
});
