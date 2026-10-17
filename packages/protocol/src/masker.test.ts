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
