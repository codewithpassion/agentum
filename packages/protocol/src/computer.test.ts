import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { file } from "bun";
import { z } from "zod";
import {
  CLIENT_ERROR_CODES,
  ClientOpRequestSchema,
  HelloMessageSchema,
  RawClientReplySchema,
} from "./computer.ts";

const FIXTURE_DIR = new URL(
  "../../../apps/computer/testdata/protocol/",
  import.meta.url
);

const ERROR_CODES_FIXTURE = "error_codes.json";

const fixtureNames = (await readdir(FIXTURE_DIR)).sort();

/**
 * Meaning, not bytes. The fixtures are pretty-printed in wire order, while zod emits keys in schema
 * order, so this compares the way the Go client's round-trip test does.
 */
function asPlainJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

/** The client's frames: a hello, or a reply to a request the server sent. */
function clientFrameSchema(name: string): z.ZodType | undefined {
  if (name.startsWith("client_to_server_hello")) {
    return HelloMessageSchema;
  }
  if (name.startsWith("client_to_server_reply_")) {
    return RawClientReplySchema;
  }
}

/**
 * A server request is one flat object: the envelope's `id` sits next to the op's own fields. The op
 * schema does not know about `id`, so it is read apart and put back, as the Go client does.
 */
function serverFrameAsPlainJson(raw: unknown): unknown {
  const { id } = z.object({ id: z.string().min(1) }).parse(raw);
  const body = ClientOpRequestSchema.parse(raw);
  return asPlainJson({ ...body, id });
}

describe("computer protocol fixtures", () => {
  test("the fixture folder holds error codes, client frames and server frames", () => {
    expect(fixtureNames).toContain(ERROR_CODES_FIXTURE);
    expect(
      fixtureNames.some((name) => name.startsWith("client_to_server_"))
    ).toBe(true);
    expect(
      fixtureNames.some((name) => name.startsWith("server_to_client_"))
    ).toBe(true);
  });

  test(`${ERROR_CODES_FIXTURE} equals CLIENT_ERROR_CODES`, async () => {
    const { codes } = z
      .object({ codes: z.array(z.string()) })
      .parse(await file(new URL(ERROR_CODES_FIXTURE, FIXTURE_DIR)).json());
    expect([...codes].sort()).toStrictEqual([...CLIENT_ERROR_CODES].sort());
  });

  for (const name of fixtureNames) {
    if (name === ERROR_CODES_FIXTURE) {
      continue;
    }
    test(name, async () => {
      const raw: unknown = await file(new URL(name, FIXTURE_DIR)).json();
      if (name.startsWith("client_to_server_")) {
        const schema = clientFrameSchema(name);
        if (schema === undefined) {
          throw new Error(`${name} matches no client frame schema`);
        }
        expect(asPlainJson(schema.parse(raw))).toStrictEqual(raw);
        return;
      }
      if (name.startsWith("server_to_client_")) {
        expect(serverFrameAsPlainJson(raw)).toStrictEqual(raw);
        return;
      }
      throw new Error(
        `${name} matches no frame prefix and is not ${ERROR_CODES_FIXTURE}`
      );
    });
  }
});
