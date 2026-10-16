// Tests for the skills client: the list and file routes, their URLs and bearer
// header, the parsing of the list answer, the masking of error text, and the
// status each failure carries.
import { describe, expect, test } from "bun:test";
import { createMasker } from "./masker.ts";
import { RunApiError } from "./run-api.ts";
import { createSkillsApi } from "./skills-api.ts";

const RUN_ID = "run_01HZXA3N5P7Q9R1S3T5V7W9X1Y";
const RUN_TOKEN = "hm_run_token_for_tests_0123456789";
const SECRET = "sk-live-do-not-leak";
const SERVER = "https://harbourmaster.example.workers.dev";
const LIST_URL = `${SERVER}/api/runs/${RUN_ID}/skills`;
const FILE_URL = `${LIST_URL}/file`;
const UNAUTHORIZED = 401;
const NOT_FOUND = 404;
const SERVER_ERROR = 500;

interface Call {
  init: RequestInit;
  url: string;
}

type Answer = (call: Call) => Response;

const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  });

const listAnswer = (files: unknown[]): Response => jsonResponse({ files });

/** A fake fetch that records every call and answers with `answer`. */
const recordingFetch = (answer: Answer = () => listAnswer([])) => {
  const calls: Call[] = [];
  const fake = (
    input: Request | URL | string,
    init?: RequestInit
  ): Promise<Response> => {
    const call: Call = { init: init ?? {}, url: String(input) };
    calls.push(call);
    return Promise.resolve(answer(call));
  };
  return { calls, fetch: Object.assign(fake, { preconnect: () => undefined }) };
};

const makeApi = (
  fetchFn: ReturnType<typeof recordingFetch>["fetch"],
  server = SERVER
) =>
  createSkillsApi({
    fetch: fetchFn,
    masker: createMasker({ api_key: SECRET }),
    runId: RUN_ID,
    runToken: RUN_TOKEN,
    server,
  });

const bearerOf = (call: Call): string | null =>
  new Headers(call.init.headers).get("authorization");

const catchError = async (work: () => Promise<unknown>): Promise<unknown> => {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
};

const SKILL_FILE = { etag: '"abc"', path: "shout/SKILL.md", size: 12 };

describe("list", () => {
  test("GETs the run's skill list with the run token as bearer", async () => {
    const { calls, fetch } = recordingFetch(() => listAnswer([SKILL_FILE]));
    await makeApi(fetch).list();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(LIST_URL);
    expect(calls[0]?.init.method).toBe("GET");
    expect(bearerOf(calls[0] as Call)).toBe(`Bearer ${RUN_TOKEN}`);
  });

  test("tolerates trailing slashes on the server origin", async () => {
    const { calls, fetch } = recordingFetch(() => listAnswer([]));
    await makeApi(fetch, `${SERVER}//`).list();

    expect(calls[0]?.url).toBe(LIST_URL);
  });

  test("returns the files of a valid answer", async () => {
    const { fetch } = recordingFetch(() => listAnswer([SKILL_FILE]));

    expect(await makeApi(fetch).list()).toEqual([SKILL_FILE]);
  });

  test("an answer that does not match the protocol throws with status 0", async () => {
    const mismatches = [
      jsonResponse({ files: [{ path: "shout/SKILL.md" }] }),
      jsonResponse({ extra: true, files: [] }),
      jsonResponse({ files: [{ ...SKILL_FILE, size: -1 }] }),
      new Response("<html>oops</html>"),
    ];
    const errors = await Promise.all(
      mismatches.map((answer) => {
        const { fetch } = recordingFetch(() => answer);
        return catchError(() => makeApi(fetch).list());
      })
    );
    for (const error of errors) {
      expect(error).toBeInstanceOf(RunApiError);
      expect((error as RunApiError).status).toBe(0);
    }
  });

  test("a 401 becomes a RunApiError with status 401", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({ error: "bad run token" }, UNAUTHORIZED)
    );
    const error = (await catchError(() =>
      makeApi(fetch).list()
    )) as RunApiError;

    expect(error).toBeInstanceOf(RunApiError);
    expect(error.status).toBe(UNAUTHORIZED);
    expect(error.message).toContain("bad run token");
  });

  test("never puts the run token in a thrown message, even when echoed", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse(
        { error: `token ${RUN_TOKEN} with ${SECRET} is not allowed` },
        UNAUTHORIZED
      )
    );
    const error = (await catchError(() =>
      makeApi(fetch).list()
    )) as RunApiError;

    expect(error.message).not.toContain(RUN_TOKEN);
    expect(error.message).not.toContain(SECRET);
    expect(error.message).toContain("[secret:run_token]");
    expect(error.message).toContain("[secret:api_key]");
    expect(error.status).toBe(UNAUTHORIZED);
  });

  test("a fetch that throws becomes a RunApiError with status 0", async () => {
    const failing = Object.assign(
      () => Promise.reject(new TypeError(`socket to ${RUN_TOKEN} dropped`)),
      { preconnect: () => undefined }
    );
    const error = (await catchError(() =>
      makeApi(failing).list()
    )) as RunApiError;

    expect(error).toBeInstanceOf(RunApiError);
    expect(error.status).toBe(0);
    expect(error.message).not.toContain(RUN_TOKEN);
  });

  test("the caller's signal cancels the request", async () => {
    const { calls, fetch } = recordingFetch(() => listAnswer([]));
    const controller = new AbortController();
    await makeApi(fetch).list(controller.signal);

    const signal = calls[0]?.init.signal;
    expect(signal?.aborted).toBe(false);
    controller.abort();
    expect(signal?.aborted).toBe(true);
  });
});

describe("file", () => {
  test("GETs the file route with the encoded path and the run token as bearer", async () => {
    const { calls, fetch } = recordingFetch(() => new Response("hello"));
    await makeApi(fetch).file("shout/scripts/helper one.sh");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      `${FILE_URL}?path=${encodeURIComponent("shout/scripts/helper one.sh")}`
    );
    expect(calls[0]?.init.method).toBe("GET");
    expect(bearerOf(calls[0] as Call)).toBe(`Bearer ${RUN_TOKEN}`);
  });

  test("returns the body bytes untouched", async () => {
    const bytes = new Uint8Array([0, 1, 2, 255, 10, 13]);
    const { fetch } = recordingFetch(() => new Response(bytes));

    expect(await makeApi(fetch).file("shout/SKILL.md")).toEqual(bytes);
  });

  test("a 404 becomes a RunApiError with status 404", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({ error: "skill file not found" }, NOT_FOUND)
    );
    const error = (await catchError(() =>
      makeApi(fetch).file("shout/missing.md")
    )) as RunApiError;

    expect(error).toBeInstanceOf(RunApiError);
    expect(error.status).toBe(NOT_FOUND);
    expect(error.message).toContain("skill file not found");
  });

  test("a 500 becomes a RunApiError with status 500", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({ error: "storage down" }, SERVER_ERROR)
    );
    const error = (await catchError(() =>
      makeApi(fetch).file("shout/SKILL.md")
    )) as RunApiError;

    expect(error.status).toBe(SERVER_ERROR);
  });

  test("never puts the run token in a thrown message, even when echoed", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({ error: `bad bearer ${RUN_TOKEN}` }, UNAUTHORIZED)
    );
    const error = (await catchError(() =>
      makeApi(fetch).file("shout/SKILL.md")
    )) as RunApiError;

    expect(error.message).not.toContain(RUN_TOKEN);
    expect(error.message).toContain("[secret:run_token]");
  });

  test("a fetch that throws becomes a RunApiError with status 0", async () => {
    const failing = Object.assign(
      () => Promise.reject(new TypeError("connection reset")),
      { preconnect: () => undefined }
    );
    const error = (await catchError(() =>
      makeApi(failing).file("shout/SKILL.md")
    )) as RunApiError;

    expect(error).toBeInstanceOf(RunApiError);
    expect(error.status).toBe(0);
  });
});
