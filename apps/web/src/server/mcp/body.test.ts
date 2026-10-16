import { expect, test } from "bun:test";
import { readCappedBody } from "./body.ts";

const requestOf = (body: string, headers: Record<string, string> = {}) =>
  new Request("http://localhost/mcp", { body, headers, method: "POST" });

test("reads a body under the cap", async () => {
  const read = await readCappedBody(requestOf("hello"), 10);
  expect(read.ok).toBe(true);
  expect(read.ok && new TextDecoder().decode(read.bytes)).toBe("hello");
});

test("refuses a declared length over the cap without reading", async () => {
  const read = await readCappedBody(
    { body: null, headers: new Headers({ "Content-Length": "11" }) },
    10
  );
  expect(read).toMatchObject({ ok: false, status: 413 });
});

test("cuts off a streamed body that passes the cap", async () => {
  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start: (controller) => {
      controller.enqueue(new Uint8Array(6));
      controller.enqueue(new Uint8Array(6));
      controller.close();
    },
  });
  const read = await readCappedBody(
    { body: stream, headers: new Headers() },
    10
  );
  expect(read).toMatchObject({ ok: false, status: 413 });
});

test("refuses a Content-Length that is not a number", async () => {
  const read = await readCappedBody(
    { body: null, headers: new Headers({ "Content-Length": "1e3" }) },
    10
  );
  expect(read).toMatchObject({ ok: false, status: 400 });
});

test("an empty body reads as no bytes", async () => {
  const read = await readCappedBody({ body: null, headers: new Headers() }, 10);
  expect(read).toEqual({ bytes: new Uint8Array(), ok: true });
});
