import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Db } from "#/db/client";
import { MAX_ATTACHMENT_BYTES } from "./attachment-rules";
import { storeAttachment, storeAttachmentStream } from "./attachment-service";

/**
 * `FixedLengthStream` is a workerd global, and these tests run under Bun, so it
 * has to be stood in for. The stub reproduces the behaviour measured against a
 * local Workers runtime: writing past the declared length errors the stream, and
 * so does closing it early. What is being tested here is our own orchestration -
 * that the put and the pipe run together, that either one failing fails the
 * upload, and that nothing is left behind - not workerd's counting.
 */
class StubFixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor(expected: number) {
    let seen = 0;
    super({
      flush() {
        if (seen !== expected) {
          throw new Error(
            "FixedLengthStream did not see all expected bytes before close()."
          );
        }
      },
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > expected) {
          throw new Error(
            "Attempt to write too many bytes through a FixedLengthStream."
          );
        }
        controller.enqueue(chunk);
      },
    });
  }
}

const globalWithStream = globalThis as unknown as {
  FixedLengthStream?: typeof StubFixedLengthStream;
};

beforeAll(() => {
  globalWithStream.FixedLengthStream = StubFixedLengthStream;
});

afterAll(() => {
  globalWithStream.FixedLengthStream = undefined;
});

/**
 * Reads the stream to the end before recording anything, which is what R2 does
 * and what these tests depend on: a fake that ignored the stream would deadlock
 * the pipe, and one that recorded the key first would hide the orphan.
 */
const fakeBucket = (objects: Map<string, Uint8Array>): R2Bucket =>
  ({
    delete(key: string) {
      objects.delete(key);
      return Promise.resolve();
    },
    async put(key: string, value: ReadableStream<Uint8Array>) {
      const bytes = new Uint8Array(await new Response(value).arrayBuffer());
      objects.set(key, bytes);
      return {};
    },
  }) as unknown as R2Bucket;

interface InsertedRow {
  filename: string;
  id: string;
  mime: string;
  r2Key: string;
  size: number;
}

/** `returning: []` is how D1 reports a write that did not land. */
const fakeDb = (inserted: InsertedRow[], returning = true): Db =>
  ({
    insert: () => ({
      values: (row: InsertedRow) => ({
        returning: () => {
          inserted.push(row);
          return Promise.resolve(returning ? [row] : []);
        },
      }),
    }),
  }) as unknown as Db;

const bodyOf = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

const filled = (size: number) => new Uint8Array(size).fill(65);

describe("storeAttachmentStream", () => {
  test("streams the body into R2 and records the row", async () => {
    const objects = new Map<string, Uint8Array>();
    const inserted: InsertedRow[] = [];
    const bytes = filled(12);

    const result = await storeAttachmentStream({
      body: bodyOf(bytes),
      bucket: fakeBucket(objects),
      db: fakeDb(inserted),
      filename: "notes.txt",
      mime: "text/plain",
      size: bytes.byteLength,
    });

    expect(result.ok).toBe(true);
    expect(inserted).toEqual([
      {
        filename: "notes.txt",
        id: expect.any(String),
        mime: "text/plain",
        r2Key: expect.any(String),
        size: 12,
      },
    ]);
    expect([...objects.values()]).toEqual([bytes]);
  });

  test("normalizes the mime type and the filename it stores", async () => {
    const inserted: InsertedRow[] = [];

    await storeAttachmentStream({
      body: bodyOf(filled(3)),
      bucket: fakeBucket(new Map()),
      db: fakeDb(inserted),
      filename: "../../etc/notes.txt",
      mime: "Text/Plain; charset=utf-8",
      size: 3,
    });

    expect(inserted[0]?.filename).toBe("notes.txt");
    expect(inserted[0]?.mime).toBe("text/plain");
  });

  test("refuses a size over the cap without touching R2", async () => {
    const objects = new Map<string, Uint8Array>();

    const result = await storeAttachmentStream({
      body: bodyOf(filled(3)),
      bucket: fakeBucket(objects),
      db: fakeDb([]),
      filename: "notes.txt",
      mime: "text/plain",
      size: MAX_ATTACHMENT_BYTES + 1,
    });

    expect(result).toEqual({
      ok: false,
      reason: "The file is larger than the 100MB limit.",
    });
    expect(objects.size).toBe(0);
  });

  test("refuses a disallowed mime type", async () => {
    const result = await storeAttachmentStream({
      body: bodyOf(filled(3)),
      bucket: fakeBucket(new Map()),
      db: fakeDb([]),
      filename: "logo.svg",
      mime: "image/svg+xml",
      size: 3,
    });

    expect(result.ok).toBe(false);
  });

  // The two ways a client can lie about Content-Length. Either has to fail the
  // upload rather than store a short object under the declared size, and either
  // has to leave R2 empty.
  test("fails the upload when the body is shorter than declared", async () => {
    const objects = new Map<string, Uint8Array>();
    const inserted: InsertedRow[] = [];

    const result = await storeAttachmentStream({
      body: bodyOf(filled(4)),
      bucket: fakeBucket(objects),
      db: fakeDb(inserted),
      filename: "notes.txt",
      mime: "text/plain",
      size: 40,
    });

    expect(result).toEqual({
      ok: false,
      reason: "The upload did not complete.",
    });
    expect(objects.size).toBe(0);
    expect(inserted).toEqual([]);
  });

  test("fails the upload when the body is longer than declared", async () => {
    const objects = new Map<string, Uint8Array>();
    const inserted: InsertedRow[] = [];

    const result = await storeAttachmentStream({
      body: bodyOf(filled(40)),
      bucket: fakeBucket(objects),
      db: fakeDb(inserted),
      filename: "notes.txt",
      mime: "text/plain",
      size: 4,
    });

    expect(result).toEqual({
      ok: false,
      reason: "The upload did not complete.",
    });
    expect(objects.size).toBe(0);
    expect(inserted).toEqual([]);
  });

  test("deletes the object when the row cannot be written", async () => {
    const objects = new Map<string, Uint8Array>();

    const attempt = storeAttachmentStream({
      body: bodyOf(filled(4)),
      bucket: fakeBucket(objects),
      db: fakeDb([], false),
      filename: "notes.txt",
      mime: "text/plain",
      size: 4,
    });

    await expect(attempt).rejects.toThrow("Failed to record the attachment.");
    expect(objects.size).toBe(0);
  });
});

/**
 * The buffering entry point the Slack mirror uses. It shares the row-writing
 * step with the streaming one now, so it is worth saying out loud that it still
 * behaves as it did.
 */
describe("storeAttachment", () => {
  test("stores a whole File and records the row", async () => {
    const objects = new Map<string, Uint8Array>();
    const inserted: InsertedRow[] = [];

    const result = await storeAttachment(
      fakeDb(inserted),
      fakeBucket(objects),
      new File(["hello"], "note.txt", { type: "text/plain" })
    );

    expect(result.ok).toBe(true);
    expect(inserted[0]).toMatchObject({
      filename: "note.txt",
      mime: "text/plain",
      size: 5,
    });
    expect(objects.size).toBe(1);
  });

  test("deletes the object when the row cannot be written", async () => {
    const objects = new Map<string, Uint8Array>();

    const attempt = storeAttachment(
      fakeDb([], false),
      fakeBucket(objects),
      new File(["hello"], "note.txt", { type: "text/plain" })
    );

    await expect(attempt).rejects.toThrow("Failed to record the attachment.");
    expect(objects.size).toBe(0);
  });
});
