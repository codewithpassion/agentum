import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { uploadFile } from "./upload-file.ts";

const record = {
  createdAt: "2026-10-16T10:00:00.000Z",
  id: "f_1",
  mime: "text/plain",
  name: "notes.txt",
  runId: null,
  size: 12,
  source: "upload",
} as const;

const originalFetch = globalThis.fetch;
let calls: { url: string; init: RequestInit | undefined }[] = [];

const stubFetch = (respond: () => Response) => {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ init, url: String(input) });
    return Promise.resolve(respond());
  }) as typeof fetch;
};

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("uploadFile", () => {
  test("posts the file as multipart and returns the record", async () => {
    stubFetch(() => Response.json(record, { status: 201 }));
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });

    const result = await uploadFile(file);

    expect(result).toEqual(record);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe("/api/files");
    expect(call?.init?.method).toBe("POST");
    expect(call?.init?.headers).toBeUndefined();
    const body = call?.init?.body;
    expect(body).toBeInstanceOf(FormData);
    const sent = (body as FormData).get("file");
    expect(sent).toBeInstanceOf(File);
    expect((sent as File).name).toBe("notes.txt");
  });

  test("throws the JSON error message from a failed response", async () => {
    stubFetch(() =>
      Response.json({ error: "File too large" }, { status: 413 })
    );

    await expect(uploadFile(new File(["x"], "big.bin"))).rejects.toThrow(
      "File too large"
    );
  });

  test("falls back to the status message when the error body is not JSON", async () => {
    stubFetch(() => new Response("<html>oops</html>", { status: 502 }));

    await expect(uploadFile(new File(["x"], "big.bin"))).rejects.toThrow(
      "Upload of big.bin failed (502)"
    );
  });

  test("throws when a 201 body does not match the record shape", async () => {
    stubFetch(() => Response.json({ id: "f_1" }, { status: 201 }));

    await expect(uploadFile(new File(["x"], "a.txt"))).rejects.toThrow();
  });
});
