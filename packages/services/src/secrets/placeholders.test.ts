import { expect, test } from "bun:test";
import {
  decidePlaceholder,
  fillPlaceholders,
  placeholderNames,
  placeholderOf,
} from "./placeholders.ts";

const grants = [
  { hosts: ["api.example.com"], name: "EXACT" },
  { hosts: ["*.example.com"], name: "WILD" },
  { hosts: [], name: "NOHOST" },
];

test("names are found in a header, a url and a json body", () => {
  expect(placeholderNames("Authorization: Bearer hm-secret:API_KEY")).toEqual([
    "API_KEY",
  ]);
  expect(
    placeholderNames("https://x.test/?k=hm-secret:TOKEN&n=hm-secret:OTHER")
  ).toEqual(["TOKEN", "OTHER"]);
  expect(
    placeholderNames('{"a":"hm-secret:JSON_A","b":{"c":"hm-secret:JSON_B1"}}')
  ).toEqual(["JSON_A", "JSON_B1"]);
});

test("names are matched greedily, so FOO_BAR is never read as FOO", () => {
  expect(placeholderNames("hm-secret:FOO_BAR")).toEqual(["FOO_BAR"]);
  expect(placeholderNames("hm-secret:_x9_")).toEqual(["_x9_"]);
});

test("names are distinct and in order of first appearance", () => {
  expect(
    placeholderNames(
      "hm-secret:B hm-secret:A hm-secret:B hm-secret:C hm-secret:A"
    )
  ).toEqual(["B", "A", "C"]);
});

test("text with no placeholder has no names", () => {
  expect(placeholderNames("plain text, no secret here")).toEqual([]);
  expect(placeholderNames("hm-secret:1BAD")).toEqual([]);
  expect(placeholderOf("TOKEN")).toBe("hm-secret:TOKEN");
});

test("fillPlaceholders passes each value through encode", () => {
  const values = new Map([["TOKEN", "a/b+c"]]);
  expect(
    fillPlaceholders(
      "https://x.test/?k=hm-secret:TOKEN",
      values,
      encodeURIComponent
    )
  ).toBe("https://x.test/?k=a%2Fb%2Bc");
});

test("fillPlaceholders without encode inserts the value as it is", () => {
  const values = new Map([["TOKEN", "a/b+c"]]);
  expect(fillPlaceholders("k=hm-secret:TOKEN", values)).toBe("k=a/b+c");
});

test("$& and $1 inside a value stay literal", () => {
  const values = new Map([["TOKEN", "x$&y$1z$$"]]);
  expect(fillPlaceholders("hm-secret:TOKEN!", values)).toBe("x$&y$1z$$!");
});

test("a value that contains a placeholder is not expanded again", () => {
  const values = new Map([
    ["A", "hm-secret:B"],
    ["B", "secret"],
  ]);
  expect(fillPlaceholders("hm-secret:A hm-secret:B", values)).toBe(
    "hm-secret:B secret"
  );
});

test("a name with no value is left as it is", () => {
  const values = new Map([["A", "1"]]);
  expect(fillPlaceholders("hm-secret:A hm-secret:C", values)).toBe(
    "1 hm-secret:C"
  );
});

test("decidePlaceholder refuses a name with no grant", () => {
  expect(decidePlaceholder("NOPE", "api.example.com", grants)).toEqual({
    message: "NOPE is not granted to this agent",
    ok: false,
  });
});

test("decidePlaceholder refuses a grant with no hosts", () => {
  expect(decidePlaceholder("NOHOST", "api.example.com", grants)).toEqual({
    message: "NOHOST has no allowed hosts. Add them in Settings, Secrets.",
    ok: false,
  });
});

test("decidePlaceholder refuses a host that matches no pattern", () => {
  expect(decidePlaceholder("EXACT", "evil.test", grants)).toEqual({
    message: "EXACT may only be sent to api.example.com",
    ok: false,
  });
});

test("decidePlaceholder allows an exact host", () => {
  expect(decidePlaceholder("EXACT", "api.example.com", grants)).toEqual({
    ok: true,
  });
});

test("decidePlaceholder allows a subdomain at any depth under a wildcard", () => {
  expect(decidePlaceholder("WILD", "api.example.com", grants)).toEqual({
    ok: true,
  });
  expect(decidePlaceholder("WILD", "a.b.example.com", grants)).toEqual({
    ok: true,
  });
});

test("decidePlaceholder does not match the bare domain under a wildcard", () => {
  expect(decidePlaceholder("WILD", "example.com", grants)).toEqual({
    message: "WILD may only be sent to *.example.com",
    ok: false,
  });
});

test("decidePlaceholder ignores a trailing dot and upper case in the host", () => {
  expect(decidePlaceholder("EXACT", "API.Example.COM.", grants)).toEqual({
    ok: true,
  });
  expect(decidePlaceholder("WILD", "A.Example.com.", grants)).toEqual({
    ok: true,
  });
});

test("decidePlaceholder cuts a long name to 64 characters in its message", () => {
  const long = "N".repeat(80);
  const decision = decidePlaceholder(long, "x.test", [
    { hosts: ["api.example.com"], name: long },
  ]);
  expect(decision).toEqual({
    message: `${"N".repeat(64)} may only be sent to api.example.com`,
    ok: false,
  });
});
