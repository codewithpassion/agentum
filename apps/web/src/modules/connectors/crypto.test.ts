import { describe, expect, test } from "bun:test";
import { decryptSecret, encryptSecret, generateConnectorKey } from "./crypto";

const KEY_SIZE_MESSAGE = /must decode to 32 bytes/;
const TRUNCATED_MESSAGE = /truncated/;

const KEY = generateConnectorKey();

describe("encryptSecret / decryptSecret", () => {
  test("round-trips a token", async () => {
    const secret = "sk-refresh-0123456789";
    expect(await decryptSecret(KEY, await encryptSecret(KEY, secret))).toBe(
      secret
    );
  });

  test.each(["", "ünïcode ✓ 🔐"])(
    "round-trips the value %p",
    async (secret) => {
      expect(await decryptSecret(KEY, await encryptSecret(KEY, secret))).toBe(
        secret
      );
    }
  );

  test("uses a fresh IV, so the same token encrypts differently each time", async () => {
    const first = await encryptSecret(KEY, "same-token");
    const second = await encryptSecret(KEY, "same-token");
    expect(first).not.toBe(second);
    expect(await decryptSecret(KEY, second)).toBe("same-token");
  });

  test("refuses a payload encrypted under another key", async () => {
    const packed = await encryptSecret(KEY, "secret");
    expect(decryptSecret(generateConnectorKey(), packed)).rejects.toThrow();
  });

  test("refuses a tampered payload - GCM authenticates the ciphertext", async () => {
    const packed = await encryptSecret(KEY, "secret");
    const tampered = `${packed.slice(0, -5)}AAAA=`;
    expect(decryptSecret(KEY, tampered)).rejects.toThrow();
  });

  test("rejects a key that is not 32 bytes", () => {
    expect(encryptSecret(btoa("short"), "secret")).rejects.toThrow(
      KEY_SIZE_MESSAGE
    );
  });

  test("rejects a truncated stored value", () => {
    expect(decryptSecret(KEY, btoa("tiny"))).rejects.toThrow(TRUNCATED_MESSAGE);
  });
});
