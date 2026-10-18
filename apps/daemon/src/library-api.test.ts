// Tests for the library client: each route's URL, method, query and bearer
// header, the mapping of 404, 400 and 409 answers, the parsing of the answers,
// the bytes of a write and a read, the masking of error text, and the status
// each failure carries.
import { describe, expect, test } from "bun:test";
import {
  LIBRARY_ETAG_HEADER,
  LIBRARY_IF_ETAG_HEADER,
} from "@repo/protocol/library";
import { createMasker } from "@repo/protocol/masker";
import { createLibraryApi } from "./library-api.ts";
import { RunApiError } from "./run-api.ts";

const RUN_ID = "run_01HZXA3N5P7Q9R1S3T5V7W9X1Y";
const RUN_TOKEN = "hm_run_token_for_tests_0123456789";
const SECRET = "sk-live-do-not-leak";
const SERVER = "https://harbourmaster.example.workers.dev";
const BASE = `${SERVER}/api/runs/${RUN_ID}/library`;
const BAD_REQUEST = 400;
const NOT_FOUND = 404;
const CONFLICT = 409;
const UNAUTHORIZED = 401;
const SERVER_ERROR = 500;
const ETAG = '"v1"';

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
  signal?: AbortSignal
) =>
  createLibraryApi({
    fetch: fetchFn,
    masker: createMasker({ api_key: SECRET }),
    runId: RUN_ID,
    runToken: RUN_TOKEN,
    server: SERVER,
    signal,
  });

const headersOf = (call: Call): Headers => new Headers(call.init.headers);

const catchError = async (work: () => Promise<unknown>): Promise<unknown> => {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
};

const ENTRY = {
  etag: ETAG,
  kind: "file" as const,
  path: "agents/ada/notes.md",
  size: 12,
};

describe("every call", () => {
  test("sends the run token as bearer and never another credential", async () => {
    const { calls, fetch } = recordingFetch(({ url, init }) => {
      if (url.includes("/stat?")) {
        return jsonResponse({ entry: ENTRY });
      }
      if (url.includes("/list?")) {
        return jsonResponse({ entries: [ENTRY] });
      }
      if (init.method === "GET") {
        return new Response("x", { headers: { [LIBRARY_ETAG_HEADER]: ETAG } });
      }
      return jsonResponse({ etag: '"v2"' });
    });
    const api = makeApi(fetch);
    await api.list("agents/ada");
    await api.stat("agents/ada/notes.md");
    await api.read("agents/ada/notes.md");
    await api.write("agents/ada/notes.md", new Uint8Array([1]));
    await api.delete("agents/ada/notes.md");
    await api.recordConflict({
      conflictPath: "agents/ada/notes.md.conflict-x",
      path: "agents/ada/notes.md",
    });

    expect(calls).toHaveLength(6);
    for (const call of calls) {
      expect(headersOf(call).get("authorization")).toBe(`Bearer ${RUN_TOKEN}`);
    }
  });
});

describe("list", () => {
  test("GETs the list route with the encoded folder", async () => {
    const { calls, fetch } = recordingFetch(() =>
      jsonResponse({ entries: [ENTRY] })
    );
    await makeApi(fetch).list("agents/ada & co");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      `${BASE}/list?path=${encodeURIComponent("agents/ada & co")}`
    );
    expect(calls[0]?.init.method).toBe("GET");
  });

  test("lists the root with an empty path", async () => {
    const { calls, fetch } = recordingFetch(() =>
      jsonResponse({ entries: [] })
    );
    await makeApi(fetch).list("");

    expect(calls[0]?.url).toBe(`${BASE}/list?path=`);
  });

  test("returns the entries of a valid answer", async () => {
    const { fetch } = recordingFetch(() => jsonResponse({ entries: [ENTRY] }));

    expect(await makeApi(fetch).list("agents/ada")).toEqual([ENTRY]);
  });

  test("a 404 lists as an empty folder", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({ error: "no such folder" }, NOT_FOUND)
    );

    expect(await makeApi(fetch).list("agents/gone")).toEqual([]);
  });

  test("an answer that does not match the protocol throws with status 0", async () => {
    const mismatches = [
      jsonResponse({ entries: [{ path: "a.md" }] }),
      jsonResponse({ entries: [], extra: true }),
      jsonResponse({ entries: [{ ...ENTRY, size: -1 }] }),
      new Response("<html>oops</html>"),
    ];
    const errors = await Promise.all(
      mismatches.map((answer) => {
        const { fetch } = recordingFetch(() => answer);
        return catchError(() => makeApi(fetch).list("agents/ada"));
      })
    );
    for (const error of errors) {
      expect(error).toBeInstanceOf(RunApiError);
      expect((error as RunApiError).status).toBe(0);
    }
  });

  test("a 500 throws a RunApiError with status 500", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({ error: "storage down" }, SERVER_ERROR)
    );
    const error = (await catchError(() =>
      makeApi(fetch).list("agents/ada")
    )) as RunApiError;

    expect(error).toBeInstanceOf(RunApiError);
    expect(error.status).toBe(SERVER_ERROR);
    expect(error.message).toContain("storage down");
  });
});

describe("stat", () => {
  test("GETs the stat route and returns the entry", async () => {
    const { calls, fetch } = recordingFetch(() =>
      jsonResponse({ entry: ENTRY })
    );

    expect(await makeApi(fetch).stat("agents/ada/notes.md")).toEqual(ENTRY);
    expect(calls[0]?.url).toBe(
      `${BASE}/stat?path=${encodeURIComponent("agents/ada/notes.md")}`
    );
    expect(calls[0]?.init.method).toBe("GET");
  });

  test("a 404 returns null", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({ error: "not found" }, NOT_FOUND)
    );

    expect(await makeApi(fetch).stat("agents/ada/missing.md")).toBeNull();
  });

  test("an answer that does not match the protocol throws with status 0", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({ entry: { kind: "x" } })
    );
    const error = (await catchError(() =>
      makeApi(fetch).stat("agents/ada/notes.md")
    )) as RunApiError;

    expect(error).toBeInstanceOf(RunApiError);
    expect(error.status).toBe(0);
  });
});

describe("read", () => {
  test("GETs the file route and returns the bytes with the etag header", async () => {
    const bytes = new Uint8Array([0, 1, 2, 255, 10, 13]);
    const { calls, fetch } = recordingFetch(
      () => new Response(bytes, { headers: { [LIBRARY_ETAG_HEADER]: ETAG } })
    );
    const read = await makeApi(fetch).read("agents/ada/data.bin");

    expect(read).toEqual({ bytes, etag: ETAG });
    expect(calls[0]?.url).toBe(
      `${BASE}/file?path=${encodeURIComponent("agents/ada/data.bin")}`
    );
    expect(calls[0]?.init.method).toBe("GET");
  });

  test("a 404 returns null", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({ error: "not found" }, NOT_FOUND)
    );

    expect(await makeApi(fetch).read("agents/ada/missing.md")).toBeNull();
  });

  test("a 400 (a folder) returns null", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({ error: "is a folder" }, BAD_REQUEST)
    );

    expect(await makeApi(fetch).read("agents/ada")).toBeNull();
  });

  test("an answer without the etag header throws", async () => {
    const { fetch } = recordingFetch(() => new Response("hello"));
    const error = (await catchError(() =>
      makeApi(fetch).read("agents/ada/notes.md")
    )) as RunApiError;

    expect(error).toBeInstanceOf(RunApiError);
    expect(error.status).toBe(0);
  });

  test("a 500 throws a RunApiError with status 500", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({ error: "storage down" }, SERVER_ERROR)
    );
    const error = (await catchError(() =>
      makeApi(fetch).read("agents/ada/notes.md")
    )) as RunApiError;

    expect(error.status).toBe(SERVER_ERROR);
  });
});

describe("write", () => {
  test("PUTs the bytes as an octet stream and returns the new etag", async () => {
    const bytes = new Uint8Array([0, 255, 128, 0]);
    const { calls, fetch } = recordingFetch(() =>
      jsonResponse({ etag: '"v2"' })
    );
    const result = await makeApi(fetch).write("agents/ada/notes.md", bytes);

    expect(result).toEqual({ etag: '"v2"' });
    expect(calls[0]?.init.method).toBe("PUT");
    expect(calls[0]?.url).toBe(
      `${BASE}/file?path=${encodeURIComponent("agents/ada/notes.md")}`
    );
    expect(calls[0]?.init.body).toEqual(bytes);
    expect(headersOf(calls[0] as Call).get("content-type")).toBe(
      "application/octet-stream"
    );
  });

  test("sends no If-Etag header without ifEtag", async () => {
    const { calls, fetch } = recordingFetch(() =>
      jsonResponse({ etag: '"v2"' })
    );
    await makeApi(fetch).write("agents/ada/notes.md", new Uint8Array([1]));

    expect(headersOf(calls[0] as Call).has(LIBRARY_IF_ETAG_HEADER)).toBe(false);
  });

  test("sends If-Etag when ifEtag is given, even an empty one", async () => {
    const { calls, fetch } = recordingFetch(() =>
      jsonResponse({ etag: '"v2"' })
    );
    const api = makeApi(fetch);
    await api.write("agents/ada/notes.md", new Uint8Array([1]), {
      ifEtag: ETAG,
    });
    await api.write("agents/ada/notes.md", new Uint8Array([1]), { ifEtag: "" });

    expect(headersOf(calls[0] as Call).get(LIBRARY_IF_ETAG_HEADER)).toBe(ETAG);
    expect(headersOf(calls[1] as Call).get(LIBRARY_IF_ETAG_HEADER)).toBe("");
  });

  test("a 409 returns null, because the file changed", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({ error: "etag mismatch" }, CONFLICT)
    );

    expect(
      await makeApi(fetch).write("agents/ada/notes.md", new Uint8Array([1]), {
        ifEtag: ETAG,
      })
    ).toBeNull();
  });

  test("a 500 throws a RunApiError with status 500", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({ error: "storage down" }, SERVER_ERROR)
    );
    const error = (await catchError(() =>
      makeApi(fetch).write("agents/ada/notes.md", new Uint8Array([1]))
    )) as RunApiError;

    expect(error).toBeInstanceOf(RunApiError);
    expect(error.status).toBe(SERVER_ERROR);
  });
});

describe("delete", () => {
  test("DELETEs the file route", async () => {
    const { calls, fetch } = recordingFetch(() => jsonResponse({}));
    await makeApi(fetch).delete("agents/ada/notes.md");

    expect(calls[0]?.init.method).toBe("DELETE");
    expect(calls[0]?.url).toBe(
      `${BASE}/file?path=${encodeURIComponent("agents/ada/notes.md")}`
    );
  });

  test("a 404 is not an error", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({ error: "not found" }, NOT_FOUND)
    );

    await makeApi(fetch).delete("agents/ada/missing.md");
  });

  test("a 500 throws a RunApiError with status 500", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({ error: "storage down" }, SERVER_ERROR)
    );
    const error = (await catchError(() =>
      makeApi(fetch).delete("agents/ada/notes.md")
    )) as RunApiError;

    expect(error.status).toBe(SERVER_ERROR);
  });
});

describe("recordConflict", () => {
  test("POSTs the conflict as JSON to the conflicts route", async () => {
    const conflict = {
      conflictPath: "agents/ada/notes.md.conflict-run_1",
      path: "agents/ada/notes.md",
    };
    const { calls, fetch } = recordingFetch(() => jsonResponse({}));
    await makeApi(fetch).recordConflict(conflict);

    expect(calls[0]?.url).toBe(`${BASE}/conflicts`);
    expect(calls[0]?.init.method).toBe("POST");
    expect(headersOf(calls[0] as Call).get("content-type")).toBe(
      "application/json"
    );
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(conflict);
  });

  test("a non-2xx answer throws a RunApiError", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({ error: "bad body" }, BAD_REQUEST)
    );
    const error = (await catchError(() =>
      makeApi(fetch).recordConflict({ conflictPath: "a", path: "b" })
    )) as RunApiError;

    expect(error).toBeInstanceOf(RunApiError);
    expect(error.status).toBe(BAD_REQUEST);
  });
});

describe("errors", () => {
  test("never puts the run token or a masked secret in a thrown message", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse(
        { error: `token ${RUN_TOKEN} with ${SECRET} is not allowed` },
        UNAUTHORIZED
      )
    );
    const error = (await catchError(() =>
      makeApi(fetch).stat("agents/ada/notes.md")
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
      makeApi(failing).list("agents/ada")
    )) as RunApiError;

    expect(error).toBeInstanceOf(RunApiError);
    expect(error.status).toBe(0);
    expect(error.message).not.toContain(RUN_TOKEN);
  });
});

describe("signal", () => {
  test("the caller's signal is passed on and cancels the request", async () => {
    const { calls, fetch } = recordingFetch(() =>
      jsonResponse({ entries: [] })
    );
    const controller = new AbortController();
    await makeApi(fetch, controller.signal).list("agents/ada");

    const signal = calls[0]?.init.signal;
    expect(signal?.aborted).toBe(false);
    controller.abort();
    expect(signal?.aborted).toBe(true);
  });
});
