// Tests for the file client: the two routes, their URLs and bearer header, the
// file names taken from download answers, the masking of error text, and the
// status each failure carries.
import { describe, expect, test } from "bun:test";
import { createMasker } from "@repo/protocol/masker";
import { createFilesApi } from "./files-api.ts";
import { RunApiError } from "./run-api.ts";

const RUN_TOKEN = "hm_run_token_for_tests_0123456789";
const SECRET = "sk-live-do-not-leak";
const FILE_ID = "01HZXA3N5P7Q9R1S3T5V7W9X1Y";
const SERVER = "https://harbourmaster.example.workers.dev";
const NOT_FOUND = 404;
const FORBIDDEN = 403;
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

const fileResponse = (bytes: string, disposition?: string): Response =>
  new Response(bytes, {
    headers:
      disposition === undefined ? {} : { "content-disposition": disposition },
    status: 200,
  });

/** A fake fetch that records every call and answers with `answer`. */
const recordingFetch = (answer: Answer = () => jsonResponse({})) => {
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
  createFilesApi({
    fetch: fetchFn,
    masker: createMasker({ api_key: SECRET }),
    runToken: RUN_TOKEN,
    server,
  });

const bearerOf = (call: Call): string | null =>
  new Headers(call.init.headers).get("authorization");

/** The name the download gives a file whose Content-Disposition is `disposition`. */
const downloadedName = async (disposition?: string): Promise<string> => {
  const { fetch } = recordingFetch(() => fileResponse("bytes", disposition));
  const { name } = await makeApi(fetch).download(FILE_ID);
  return name;
};

const catchError = async (work: () => Promise<unknown>): Promise<unknown> => {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
};

describe("download", () => {
  test("GETs the file with the run token as bearer", async () => {
    const { calls, fetch } = recordingFetch(() => fileResponse("hello"));
    await makeApi(fetch).download(FILE_ID);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${SERVER}/files/${FILE_ID}`);
    expect(calls[0]?.init.method).toBe("GET");
    expect(bearerOf(calls[0] as Call)).toBe(`Bearer ${RUN_TOKEN}`);
  });

  test("tolerates trailing slashes on the server origin", async () => {
    const { calls, fetch } = recordingFetch(() => fileResponse("hello"));
    await makeApi(fetch, `${SERVER}///`).download(FILE_ID);

    expect(calls[0]?.url).toBe(`${SERVER}/files/${FILE_ID}`);
  });

  test("returns the body bytes as a Blob", async () => {
    const { fetch } = recordingFetch(() => fileResponse("hello world"));
    const { body } = await makeApi(fetch).download(FILE_ID);

    expect(body).toBeInstanceOf(Blob);
    expect(await body.text()).toBe("hello world");
  });

  test("takes the name from filename*", async () => {
    const name = await downloadedName(
      "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9%202026.pdf"
    );
    expect(name).toBe("résumé 2026.pdf");
  });

  test("takes the name from a plain filename", async () => {
    expect(await downloadedName('attachment; filename="report.pdf"')).toBe(
      "report.pdf"
    );
  });

  test("falls back to filename when filename* does not decode", async () => {
    const name = await downloadedName(
      "attachment; filename*=UTF-8''%E0%A4%A; filename=\"plain.txt\""
    );
    expect(name).toBe("plain.txt");
  });

  test("names the file 'file' when the header names none", async () => {
    expect(await downloadedName()).toBe("file");
    expect(await downloadedName("attachment")).toBe("file");
  });

  test.each([
    ['attachment; filename="../../etc/passwd"', "passwd"],
    ["attachment; filename*=UTF-8''..%2F..%2Fetc%2Fpasswd", "passwd"],
    ['attachment; filename="..\\\\x"', "x"],
    ['attachment; filename="..\\\\..\\\\boot.ini"', "boot.ini"],
    ['attachment; filename=".bashrc"', "bashrc"],
    ['attachment; filename=".."', "file"],
    ['attachment; filename=""', "file"],
    ['attachment; filename="dir/"', "file"],
    ["attachment; filename*=UTF-8''a%0Ab%00c.txt", "a_b_c.txt"],
  ])("makes %s safe as %s", async (disposition, expected) => {
    expect(await downloadedName(disposition)).toBe(expected);
  });

  test("a 404 becomes a RunApiError with status 404", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({ error: "file not found" }, NOT_FOUND)
    );
    const error = await catchError(() => makeApi(fetch).download(FILE_ID));

    expect(error).toBeInstanceOf(RunApiError);
    expect((error as RunApiError).status).toBe(NOT_FOUND);
    expect((error as RunApiError).message).toContain("file not found");
  });

  test("never puts the run token in a thrown message, even when echoed", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse(
        { error: `token ${RUN_TOKEN} with ${SECRET} is not allowed` },
        FORBIDDEN
      )
    );
    const error = (await catchError(() =>
      makeApi(fetch).download(FILE_ID)
    )) as RunApiError;

    expect(error.message).not.toContain(RUN_TOKEN);
    expect(error.message).not.toContain(SECRET);
    expect(error.message).toContain("[secret:run_token]");
    expect(error.message).toContain("[secret:api_key]");
    expect(error.status).toBe(FORBIDDEN);
  });

  test("a fetch that throws becomes a RunApiError with status 0", async () => {
    const failing = Object.assign(
      () => Promise.reject(new TypeError(`socket to ${RUN_TOKEN} dropped`)),
      { preconnect: () => undefined }
    );
    const error = (await catchError(() =>
      makeApi(failing).download(FILE_ID)
    )) as RunApiError;

    expect(error).toBeInstanceOf(RunApiError);
    expect(error.status).toBe(0);
    expect(error.message).not.toContain(RUN_TOKEN);
  });

  test("the caller's signal cancels the request", async () => {
    const { calls, fetch } = recordingFetch(() => fileResponse("hello"));
    const controller = new AbortController();
    await makeApi(fetch).download(FILE_ID, controller.signal);

    const signal = calls[0]?.init.signal;
    expect(signal?.aborted).toBe(false);
    controller.abort();
    expect(signal?.aborted).toBe(true);
  });
});

describe("upload", () => {
  test("POSTs multipart to /api/files with the run token as bearer", async () => {
    const { calls, fetch } = recordingFetch(() => jsonResponse({ id: "f1" }));
    await makeApi(fetch).upload({
      body: new Blob(["data"], { type: "text/plain" }),
      name: "notes.txt",
    });

    expect(calls[0]?.url).toBe(`${SERVER}/api/files`);
    expect(calls[0]?.init.method).toBe("POST");
    expect(bearerOf(calls[0] as Call)).toBe(`Bearer ${RUN_TOKEN}`);
  });

  test("tolerates trailing slashes on the server origin", async () => {
    const { calls, fetch } = recordingFetch(() => jsonResponse({ id: "f1" }));
    await makeApi(fetch, `${SERVER}/`).upload({
      body: new Blob(["data"]),
      name: "notes.txt",
    });

    expect(calls[0]?.url).toBe(`${SERVER}/api/files`);
  });

  test("sends one file field holding the bytes and the name", async () => {
    const { calls, fetch } = recordingFetch(() => jsonResponse({ id: "f1" }));
    await makeApi(fetch).upload({
      body: new Blob(["binary\u0000data"], {
        type: "application/octet-stream",
      }),
      name: "out.bin",
    });

    const form = calls[0]?.init.body;
    expect(form).toBeInstanceOf(FormData);
    const part = (form as FormData).get("file");
    expect(part).toBeInstanceOf(File);
    const file = part as File;
    expect(file.name).toBe("out.bin");
    expect(file.type).toBe("application/octet-stream");
    expect(await file.text()).toBe("binary\u0000data");
  });

  test("resolves with the id the Worker returns", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({ id: "file_42" }, 201)
    );
    const result = await makeApi(fetch).upload({
      body: new Blob(["x"]),
      name: "x.txt",
    });

    expect(result).toEqual({ id: "file_42" });
  });

  test("an answer without a string id throws", async () => {
    const { fetch } = recordingFetch(() => jsonResponse({ id: 7 }));
    const error = await catchError(() =>
      makeApi(fetch).upload({ body: new Blob(["x"]), name: "x.txt" })
    );

    expect(error).toBeInstanceOf(RunApiError);
    expect((error as RunApiError).status).toBe(0);
  });

  test("a non-JSON answer without an id throws", async () => {
    const { fetch } = recordingFetch(() => new Response("ok"));
    const error = await catchError(() =>
      makeApi(fetch).upload({ body: new Blob(["x"]), name: "x.txt" })
    );

    expect(error).toBeInstanceOf(RunApiError);
  });

  test("a non-2xx answer becomes a RunApiError with its status", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({ error: "too large" }, SERVER_ERROR)
    );
    const error = (await catchError(() =>
      makeApi(fetch).upload({ body: new Blob(["x"]), name: "x.txt" })
    )) as RunApiError;

    expect(error.status).toBe(SERVER_ERROR);
    expect(error.message).toContain("too large");
  });

  test("never puts the run token in a thrown message, even when echoed", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({ error: `bad bearer ${RUN_TOKEN}` }, FORBIDDEN)
    );
    const error = (await catchError(() =>
      makeApi(fetch).upload({ body: new Blob(["x"]), name: "x.txt" })
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
      makeApi(failing).upload({ body: new Blob(["x"]), name: "x.txt" })
    )) as RunApiError;

    expect(error).toBeInstanceOf(RunApiError);
    expect(error.status).toBe(0);
  });
});
