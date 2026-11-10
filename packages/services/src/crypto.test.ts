import { expect, test } from "bun:test";
import {
  CryptoError,
  constantTimeEqual,
  decryptSecret,
  encryptSecret,
  hashedToken,
  hashToken,
  importSecretsKey,
  isCryptoError,
  keySpec,
  splitKeySpec,
  tokenMatchesHash,
} from "./crypto.ts";

const keyBase64 = (fill: number) =>
  Buffer.from(new Uint8Array(32).fill(fill)).toString("base64");

const A = {
  field: "linear_api_key",
  rowId: "row_1",
  table: "workspaces",
  workspaceId: "ws_a",
};
const PLAINTEXT = "lin_api_not-a-real-key-0123456789";
const BASE64URL_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * How `promise` failed: the CryptoError code, and whether its message gave
 * away the plaintext or `stored` (the stored text or key it was handed).
 */
const failureOf = async (promise: Promise<unknown>, stored: string) => {
  try {
    await promise;
    return { code: "resolved", leaks: false };
  } catch (error: unknown) {
    if (!isCryptoError(error)) {
      return { code: "not a CryptoError", leaks: false };
    }
    const leaks =
      error.message.includes(PLAINTEXT) ||
      (stored !== "" && error.message.includes(stored));
    return { code: error.code, leaks };
  }
};

const UNREADABLE = { code: "unavailable", leaks: false };

/** `text` (base64url) with its first byte changed. */
const changeFirstByte = (text: string) => {
  const bytes = Buffer.from(text, "base64url");
  bytes[0] = ((bytes[0] ?? 0) + 1) % 256;
  return bytes.toString("base64url");
};

test("round trip: v1 prefix, a fresh IV per value, the same plaintext back", async () => {
  const key = await importSecretsKey(keyBase64(7));
  const first = await encryptSecret(key, A, PLAINTEXT);
  const second = await encryptSecret(key, A, PLAINTEXT);
  expect(first.startsWith("v1:")).toBe(true);
  expect(first.split(":")).toHaveLength(3);
  expect(first).not.toBe(second);
  expect(first).not.toContain(PLAINTEXT);
  expect(await decryptSecret(key, A, first)).toBe(PLAINTEXT);
  expect(await decryptSecret(key, A, second)).toBe(PLAINTEXT);
  expect(await decryptSecret(key, A, await encryptSecret(key, A, ""))).toBe("");
});

test("another key cannot decrypt", async () => {
  const stored = await encryptSecret(
    await importSecretsKey(keyBase64(1)),
    A,
    PLAINTEXT
  );
  const other = await importSecretsKey(keyBase64(2));
  expect(await failureOf(decryptSecret(other, A, stored), stored)).toEqual(
    UNREADABLE
  );
});

test("the additional data binds workspace, table, row and field", async () => {
  const key = await importSecretsKey(keyBase64(3));
  const stored = await encryptSecret(key, A, PLAINTEXT);
  const changed = [
    { ...A, workspaceId: "ws_b" },
    { ...A, table: "other_table" },
    { ...A, rowId: "row_2" },
    { ...A, field: "twenty_api_key" },
  ];
  const failures = await Promise.all(
    changed.map((binding) =>
      failureOf(decryptSecret(key, binding, stored), stored)
    )
  );
  expect(failures).toEqual(changed.map(() => UNREADABLE));
});

test("ids that join to the same text under a separator bind differently", async () => {
  const key = await importSecretsKey(keyBase64(8));
  const left = { field: "y", rowId: "r", table: "t", workspaceId: "ws_a:x" };
  const right = { field: "x:y", rowId: "r", table: "t", workspaceId: "ws_a" };
  const stored = await encryptSecret(key, left, PLAINTEXT);
  expect(await failureOf(decryptSecret(key, right, stored), stored)).toEqual(
    UNREADABLE
  );
});

test("a changed ciphertext or IV fails", async () => {
  const key = await importSecretsKey(keyBase64(4));
  const stored = await encryptSecret(key, A, PLAINTEXT);
  const [version, iv, data] = stored.split(":") as [string, string, string];
  const tamperedData = `${version}:${iv}:${changeFirstByte(data)}`;
  const tamperedIv = `${version}:${changeFirstByte(iv)}:${data}`;
  expect(
    await failureOf(decryptSecret(key, A, tamperedData), tamperedData)
  ).toEqual(UNREADABLE);
  expect(
    await failureOf(decryptSecret(key, A, tamperedIv), tamperedIv)
  ).toEqual(UNREADABLE);
});

test("a bad prefix or format fails without trying to decrypt", async () => {
  const key = await importSecretsKey(keyBase64(5));
  const stored = await encryptSecret(key, A, PLAINTEXT);
  const [, iv, data] = stored.split(":") as [string, string, string];
  const bad = [
    `v2:${iv}:${data}`,
    `${iv}:${data}`,
    `v1:${iv}:${data}:extra`,
    `v1::${data}`,
    `v1:${iv}:`,
    `v1:${iv}:not base64!`,
    `v1:${iv.slice(2)}:${data}`,
    "",
    PLAINTEXT,
  ];
  const failures = await Promise.all(
    bad.map((text) => failureOf(decryptSecret(key, A, text), text))
  );
  expect(failures).toEqual(bad.map(() => UNREADABLE));
});

test("the key must be exactly 32 bytes of base64 and is not extractable", async () => {
  const bad = [
    Buffer.from(new Uint8Array(16)).toString("base64"),
    Buffer.from(new Uint8Array(33)).toString("base64"),
    "not base64 at all!",
    "",
  ];
  const failures = await Promise.all(
    bad.map((text) => failureOf(importSecretsKey(text), text))
  );
  expect(failures).toEqual(bad.map(() => UNREADABLE));
  const key = await importSecretsKey(keyBase64(6));
  expect(key.extractable).toBe(false);
  expect(await crypto.subtle.exportKey("raw", key).catch(() => null)).toBe(
    null
  );
});

test("a bad key error keeps the decoding error as its cause", async () => {
  const error = await importSecretsKey("not base64 at all!").catch(
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(CryptoError);
  expect(isCryptoError(error) && error.cause).toBeDefined();
});

test("hashToken: SHA-256 of the UTF-8 token, lowercase hex", async () => {
  expect(await hashToken("abc")).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
  expect(await hashToken("abc")).toMatch(SHA256_HEX);
});

test("hashedToken: prefix kept, 43 base64url characters after it, hash of the token", async () => {
  const { token, hash } = await hashedToken("whk_");
  expect(token.startsWith("whk_")).toBe(true);
  expect(token.slice("whk_".length)).toMatch(BASE64URL_TOKEN);
  expect(hash).toBe(await hashToken(token));
  const other = await hashedToken("whk_");
  expect(other.token).not.toBe(token);
});

test("tokenMatchesHash accepts only the token its hash came from", async () => {
  const { token, hash } = await hashedToken("p_");
  expect(await tokenMatchesHash(token, hash)).toBe(true);
  expect(await tokenMatchesHash(`${token}x`, hash)).toBe(false);
  expect(await tokenMatchesHash(token, await hashToken("other"))).toBe(false);
  expect(await tokenMatchesHash(token, "")).toBe(false);
});

test("constantTimeEqual: equal, one differing byte, lengths, empty", () => {
  expect(
    constantTimeEqual(Uint8Array.from([1, 2, 3]), Uint8Array.from([1, 2, 3]))
  ).toBe(true);
  expect(
    constantTimeEqual(Uint8Array.from([1, 2, 3]), Uint8Array.from([1, 2, 4]))
  ).toBe(false);
  expect(
    constantTimeEqual(Uint8Array.from([1, 2]), Uint8Array.from([1, 2, 3]))
  ).toBe(false);
  expect(constantTimeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
});

test("a value written under the old key reads under the new pair", async () => {
  const oldKey = await importSecretsKey(keyBase64(1));
  const stored = await encryptSecret(oldKey, A, PLAINTEXT);
  const pair = await importSecretsKey(keySpec(keyBase64(2), keyBase64(1)));
  expect(await decryptSecret(pair, A, stored)).toBe(PLAINTEXT);
});

test("with a previous key set, new values are written under the current key", async () => {
  const pair = await importSecretsKey(keySpec(keyBase64(2), keyBase64(1)));
  const stored = await encryptSecret(pair, A, PLAINTEXT);
  const current = await importSecretsKey(keyBase64(2));
  const previous = await importSecretsKey(keyBase64(1));
  expect(await decryptSecret(current, A, stored)).toBe(PLAINTEXT);
  expect(
    (await failureOf(decryptSecret(previous, A, stored), stored)).code
  ).toBe("unavailable");
});

test("a value under neither key of the pair does not read", async () => {
  const stranger = await importSecretsKey(keyBase64(3));
  const stored = await encryptSecret(stranger, A, PLAINTEXT);
  const pair = await importSecretsKey(keySpec(keyBase64(2), keyBase64(1)));
  const failure = await failureOf(decryptSecret(pair, A, stored), stored);
  expect(failure).toEqual({ code: "unavailable", leaks: false });
});

test("the old key still checks the binding", async () => {
  const oldKey = await importSecretsKey(keyBase64(1));
  const stored = await encryptSecret(oldKey, A, PLAINTEXT);
  const pair = await importSecretsKey(keySpec(keyBase64(2), keyBase64(1)));
  const failure = await failureOf(
    decryptSecret(pair, { ...A, rowId: "row_2" }, stored),
    stored
  );
  expect(failure.code).toBe("unavailable");
});

test("an empty or missing previous key leaves the key as it was", () => {
  expect(keySpec(keyBase64(2), "")).toBe(keyBase64(2));
  expect(keySpec(keyBase64(2), undefined)).toBe(keyBase64(2));
  expect(splitKeySpec(keyBase64(2))).toEqual({
    current: keyBase64(2),
    previous: undefined,
  });
  expect(splitKeySpec(keySpec(keyBase64(2), keyBase64(1)))).toEqual({
    current: keyBase64(2),
    previous: keyBase64(1),
  });
});

test("a malformed previous key is refused, not ignored", async () => {
  const failure = await failureOf(
    importSecretsKey(keySpec(keyBase64(2), "short")),
    "short"
  );
  expect(failure.code).toBe("unavailable");
});
