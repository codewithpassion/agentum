import { expect, test } from "bun:test";
import type { ProxyMatch } from "../secrets.ts";
import { scrubBody, scrubText } from "./scrub.ts";

const VALUE = "scrub-value-0123456789";
const matches: ProxyMatch[] = [
  {
    header: "Authorization",
    headerValue: `Bearer ${VALUE}`,
    name: "OPENAI_API_KEY",
    value: VALUE,
  },
];
const bytes = (text: string) => new TextEncoder().encode(text);
const decode = (data: Uint8Array) => new TextDecoder().decode(data);

test("a json body that echoes the value, raw or escaped, is scrubbed", () => {
  const body = JSON.stringify({ again: VALUE, auth: `Bearer ${VALUE}` });
  const scrubbed = decode(scrubBody(bytes(body), "application/json", matches));
  expect(scrubbed).not.toContain(VALUE);
  expect(scrubbed).toContain("[secret:OPENAI_API_KEY]");
});

test("a text body without a content type is scrubbed, a binary one is untouched", () => {
  expect(decode(scrubBody(bytes(`x ${VALUE} y`), null, matches))).toBe(
    "x [secret:OPENAI_API_KEY] y"
  );
  const binary = bytes(`x ${VALUE} y`);
  expect(scrubBody(binary, "application/octet-stream", matches)).toBe(binary);
  expect(scrubBody(binary, "image/png", matches)).toBe(binary);
});

test("with no secret applied, the body is returned as it came", () => {
  const body = bytes("hello");
  expect(scrubBody(body, "text/plain", [])).toBe(body);
  expect(scrubText("hello", [])).toBe("hello");
});

test("scrubText covers a header value", () => {
  expect(scrubText(`https://x.test/?k=${VALUE}`, matches)).toBe(
    "https://x.test/?k=[secret:OPENAI_API_KEY]"
  );
});
