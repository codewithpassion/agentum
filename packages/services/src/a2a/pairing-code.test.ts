import { describe, expect, test } from "bun:test";
import {
  checkCode,
  PAIRING_ALPHABET,
  PAIRING_CODE_LENGTH,
  randomPairingCode,
} from "./pairing-code.ts";

const CODE_PATTERN = new RegExp(
  `^[${PAIRING_ALPHABET}]{${PAIRING_CODE_LENGTH}}$`
);

describe("checkCode", () => {
  test("returns 8 alphabet characters", async () => {
    const code = await checkCode("invite-token", "joiner-token");
    expect(code).toHaveLength(PAIRING_CODE_LENGTH);
    expect(code).toMatch(CODE_PATTERN);
  });

  test("is deterministic", async () => {
    expect(await checkCode("a", "b")).toBe(await checkCode("a", "b"));
  });

  test("changes when the invite token changes", async () => {
    expect(await checkCode("a", "joiner")).not.toBe(
      await checkCode("b", "joiner")
    );
  });

  test("changes when the joiner token changes", async () => {
    expect(await checkCode("invite", "a")).not.toBe(
      await checkCode("invite", "b")
    );
  });

  test("changes when the token order is swapped", async () => {
    expect(await checkCode("a", "b")).not.toBe(await checkCode("b", "a"));
  });
});

describe("PAIRING_ALPHABET", () => {
  test("has 32 unique characters with no 0, O, 1 or I", () => {
    expect(PAIRING_ALPHABET).toHaveLength(32);
    expect(new Set(PAIRING_ALPHABET).size).toBe(32);
    for (const ambiguous of ["0", "O", "1", "I"]) {
      expect(PAIRING_ALPHABET).not.toContain(ambiguous);
    }
  });
});

describe("randomPairingCode", () => {
  test("returns 8 alphabet characters", () => {
    expect(randomPairingCode()).toMatch(CODE_PATTERN);
  });

  test("two calls differ", () => {
    expect(randomPairingCode()).not.toBe(randomPairingCode());
  });
});
