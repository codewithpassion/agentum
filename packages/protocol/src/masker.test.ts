// Tests for the secret masker: raw and JSON-encoded replacement, longest
// first, the object walk, and the empty and no-match cases.
import { describe, expect, test } from "bun:test";
import { createMasker } from "./masker.ts";

describe("raw replacement", () => {
  test("replaces each value with its name", () => {
    const masker = createMasker({
      machine_credential: "hm_mach_xyz789",
      run_token: "hm_run_abc123",
    });
    expect(masker.mask("token hm_run_abc123 and hm_mach_xyz789 end")).toBe(
      "token [secret:run_token] and [secret:machine_credential] end"
    );
  });

  test("text with no secret comes back unchanged", () => {
    const masker = createMasker({ run_token: "hm_run_abc123" });
    expect(masker.mask("nothing to see here")).toBe("nothing to see here");
  });
});

describe("JSON-encoded replacement", () => {
  test("masks a value with a quote in its JSON-encoded form", () => {
    const masker = createMasker({ QUOTED: 'a"b' });
    const line = JSON.stringify({ body: 'a"b', note: "plain" });
    const masked = masker.mask(line);
    expect(masked).toBe('{"body":"[secret:QUOTED]","note":"plain"}');
    expect(() => JSON.parse(masked)).not.toThrow();
  });

  test("masks a value with a backslash and keeps the document parseable", () => {
    const masker = createMasker({ TOK: "abc\\def" });
    const line = JSON.stringify({ note: "value abc\\def ends" });
    const masked = masker.mask(line);
    expect(masked).not.toContain("abc");
    expect(() => JSON.parse(masked)).not.toThrow();
  });
});

describe("longest first", () => {
  test("a value that contains another is replaced whole", () => {
    const masker = createMasker({
      NESTED: "token123extra",
      PLAIN: "token123",
    });
    expect(masker.mask("the value is token123extra here")).toBe(
      "the value is [secret:NESTED] here"
    );
    expect(masker.mask("plain token123 alone")).toBe(
      "plain [secret:PLAIN] alone"
    );
  });
});

describe("maskDeep", () => {
  test("masks strings in nested objects and arrays", () => {
    const masker = createMasker({ TOK: "abcdefgh" });
    const masked = masker.maskDeep({
      envelope: {
        artifacts: [{ path: "docs/abcdefgh/x.md" }],
        count: 3,
        none: null,
        ok: true,
      },
      reason: "abcdefgh was here",
    });
    expect(masked).toEqual({
      envelope: {
        artifacts: [{ path: "docs/[secret:TOK]/x.md" }],
        count: 3,
        none: null,
        ok: true,
      },
      reason: "[secret:TOK] was here",
    });
  });

  test("leaves non-string primitives alone", () => {
    const masker = createMasker({ TOK: "abcdefgh" });
    expect(masker.maskDeep(42)).toBe(42);
    expect(masker.maskDeep(false)).toBe(false);
    expect(masker.maskDeep(null)).toBeNull();
    expect(masker.maskDeep(undefined)).toBeUndefined();
  });

  test("keeps the JSON-encoded document parseable with a backslash value", () => {
    const masker = createMasker({ TOK: "abc\\def" });
    const masked = masker.maskDeep({
      reason: "the value abc\\def broke the old round trip",
    });
    const encoded = JSON.stringify(masked);
    expect(encoded).toContain("[secret:TOK]");
    expect(() => JSON.parse(encoded)).not.toThrow();
  });
});

describe("empty values", () => {
  test("an empty value is ignored and does not split the text", () => {
    const masker = createMasker({ EMPTY: "", TOK: "abcdefgh" });
    expect(masker.mask("hello abcdefgh world")).toBe(
      "hello [secret:TOK] world"
    );
    expect(masker.mask("no secret here")).toBe("no secret here");
  });

  test("no secrets at all is the identity", () => {
    const masker = createMasker({});
    expect(masker.mask("anything at all")).toBe("anything at all");
    expect(masker.maskDeep({ a: ["b"] })).toEqual({ a: ["b"] });
  });
});

describe("base64 and URL-encoded forms", () => {
  // "a b&c/d": base64 YSBiJmMvZA==, URL %20 %26 %2F, form-encoded a+b%26c%2Fd.
  const VALUE = "a b&c/d";

  test("masks the standard base64 of a value", () => {
    const masker = createMasker({ TOK: VALUE });
    expect(masker.mask("Basic YSBiJmMvZA== end")).toBe(
      "Basic [secret:TOK] end"
    );
  });

  test("masks the URL-encoded form of a value", () => {
    const masker = createMasker({ TOK: VALUE });
    expect(masker.mask("q=a%20b%26c%2Fd&next=1")).toBe("q=[secret:TOK]&next=1");
  });

  test("masks the form-encoded form, where a space is +", () => {
    const masker = createMasker({ TOK: VALUE });
    expect(masker.mask("q=a+b%26c%2Fd")).toBe("q=[secret:TOK]");
  });

  test("a value whose URL-encoded form equals itself is still masked", () => {
    const masker = createMasker({ TOK: "abcdefgh" });
    expect(masker.mask("abcdefgh and YWJjZGVmZ2g=")).toBe(
      "[secret:TOK] and [secret:TOK]"
    );
  });

  test("masks the base64 of a non-ASCII value", () => {
    const masker = createMasker({ TOK: "pässwörd✓" });
    expect(masker.mask("auth cMOkc3N3w7ZyZOKckw== end")).toBe(
      "auth [secret:TOK] end"
    );
  });

  test("masks the URL-encoded form of a non-ASCII value", () => {
    const masker = createMasker({ TOK: "pässwörd✓" });
    expect(masker.mask("p%C3%A4ssw%C3%B6rd%E2%9C%93")).toBe("[secret:TOK]");
  });

  test("text with none of the forms is unchanged", () => {
    const masker = createMasker({ TOK: VALUE });
    const text = "nothing here: a-b c&d/e YWJj q=abc";
    expect(masker.mask(text)).toBe(text);
  });

  test("masks the base64 of a value with a trailing newline", () => {
    const masker = createMasker({ TOK: "abcdefgh" });
    const piped = Buffer.from("abcdefgh\n").toString("base64");
    expect(masker.mask(`auth ${piped} end`)).toBe("auth [secret:TOK] end");
  });

  test("masks the form encoding of marks encodeURIComponent keeps", () => {
    const masker = createMasker({ TOK: "it's(a)~key!" });
    const form = new URLSearchParams({ k: "it's(a)~key!" }).toString();
    expect(form).toBe("k=it%27s%28a%29%7Ekey%21");
    expect(masker.mask(form)).toBe("k=[secret:TOK]");
  });
});

describe("unfinishedTail", () => {
  test("counts the end of the text that begins a value, spaces and newlines included", () => {
    const masker = createMasker({ KEY: "line one\nline two" });
    expect(masker.unfinishedTail("see line one\nli")).toBe(
      "line one\nli".length
    );
    expect(masker.unfinishedTail("see line")).toBe("line".length);
  });

  test("is zero when the end begins no value or the value is whole", () => {
    const masker = createMasker({ TOK: "hm_run_abc123" });
    expect(masker.unfinishedTail("nothing here")).toBe(0);
    expect(masker.unfinishedTail("")).toBe(0);
    expect(masker.unfinishedTail("then hm_run_abc123")).toBe(0);
  });

  test("covers the encoded shapes of a value", () => {
    const masker = createMasker({ TOK: "a b" });
    expect(masker.unfinishedTail("x a%2")).toBe("a%2".length);
  });

  test("takes the longest start across values", () => {
    const masker = createMasker({ ONE: "abcdef", TWO: "cdxyz" });
    expect(masker.unfinishedTail("abcd")).toBe(4);
  });
});
