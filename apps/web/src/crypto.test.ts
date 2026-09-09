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

/**
 * The AAD parameter, added for workspace secrets. Two properties matter and
 * neither is provable by a round trip through the new code alone: values
 * written before AAD existed must still decrypt, and a ciphertext moved to a
 * row with different AAD must not.
 */
describe("additionalData", () => {
  /**
   * Produced by the pre-AAD implementation and hardcoded on purpose - a fresh
   * `encryptSecret` here would prove only that the new code agrees with
   * itself. This is the format already in D1.
   */
  const LEGACY = {
    ciphertext:
      "zsvzoGyDJvh2urzJYz/Wv6Y9kbBmK9WqWcP4LbaKKGGTp7ifCRG+MCl299oQoBFgQlXTPjkA",
    key: "N/9P6g8vwFxqw2p6fAAovl8d6o+TkbmXyKuo+A/5Gho=",
    plaintext: "sk-legacy-value-0123456789",
  } as const;

  test("a value written before AAD existed still decrypts", async () => {
    expect(await decryptSecret(LEGACY.key, LEGACY.ciphertext)).toBe(
      LEGACY.plaintext
    );
  });

  test("round-trips with AAD", async () => {
    const aad = "ws_1:sec_1";
    const packed = await encryptSecret(KEY, "deepgram-key", aad);
    expect(await decryptSecret(KEY, packed, aad)).toBe("deepgram-key");
  });

  test("a ciphertext moved to another row's AAD does not decrypt", async () => {
    const packed = await encryptSecret(KEY, "deepgram-key", "ws_1:sec_1");
    // The same workspace, a different secret row - the copy an attacker with
    // write access to D1 would make.
    expect(decryptSecret(KEY, packed, "ws_1:sec_2")).rejects.toThrow();
    // And the same secret id under another tenant.
    expect(decryptSecret(KEY, packed, "ws_2:sec_1")).rejects.toThrow();
  });

  test("AAD is not optional at rest: omitting it fails, and so does adding it", async () => {
    const withAad = await encryptSecret(KEY, "value", "ws_1:sec_1");
    expect(decryptSecret(KEY, withAad)).rejects.toThrow();

    const without = await encryptSecret(KEY, "value");
    expect(decryptSecret(KEY, without, "ws_1:sec_1")).rejects.toThrow();
  });

  /**
   * GCM authenticates zero bytes of AAD exactly as it authenticates none, so
   * `""` and "omitted" produce the same tag. Asserted rather than assumed: a
   * caller that binds a row must bind a non-empty string, which the one AAD
   * this codebase builds - `${workspaceId}:${secretId}` - always is.
   */
  test("an empty AAD is indistinguishable from no AAD", async () => {
    const packed = await encryptSecret(KEY, "value", "");
    expect(await decryptSecret(KEY, packed, "")).toBe("value");
    expect(await decryptSecret(KEY, packed)).toBe("value");
  });
});
