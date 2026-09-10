import { describe, expect, test } from "bun:test";
import { generateConnectorKey } from "#/crypto";
import {
  attachmentLinkPath,
  clampLinkTtl,
  DEFAULT_LINK_TTL_SECONDS,
  MAX_LINK_TTL_SECONDS,
  signAttachmentLink,
  verifyAttachmentLink,
} from "./attachment-links";

/**
 * The whole security argument for the public read route is in this file, so the
 * negative cases matter more than the happy path: an expiry that moved, an id
 * that moved, a signature from another deployment's key, and a deployment with
 * no key at all.
 *
 * `generateConnectorKey` is reused deliberately - `ATTACHMENT_LINK_KEY` has the
 * same shape as `CONNECTOR_KEY`, base64 of 32 bytes.
 */

const KEY = generateConnectorKey();
const ID = "3f2a1b4c-0000-4000-8000-000000000001";
const NOW = 1_760_000_000_000;

const NOT_CONFIGURED = /ATTACHMENT_LINK_KEY is not configured/;
const NOT_BASE64 = /not valid base64/;
const WRONG_LENGTH = /must decode to 32 bytes, got 31/;
const URL_SAFE = /^[A-Za-z0-9_-]+$/;

const sign = (ttlSeconds?: number) =>
  signAttachmentLink(KEY, { id: ID, now: NOW, ttlSeconds });

describe("signing", () => {
  test("a fresh link verifies, and the expiry is the ttl from now", async () => {
    const link = await sign(120);

    expect(link.id).toBe(ID);
    expect(link.expiresAt).toBe(NOW / 1000 + 120);
    expect(
      await verifyAttachmentLink(KEY, {
        exp: String(link.expiresAt),
        id: ID,
        now: NOW,
        sig: link.signature,
      })
    ).toBe(true);
  });

  test("the signature is url-safe, so it survives a query string", async () => {
    // Fresh keys each time: base64 of a random MAC hits + and / eventually, and
    // one of those in a query string is a decoded space or a path separator.
    const signatures = await Promise.all(
      Array.from({ length: 40 }, () =>
        signAttachmentLink(generateConnectorKey(), { id: ID, now: NOW })
      )
    );

    for (const link of signatures) {
      expect(link.signature).toMatch(URL_SAFE);
    }
  });

  test("the path carries the id, the expiry and the signature", async () => {
    const link = await sign();
    const url = new URL(attachmentLinkPath(link), "https://app.example.com");

    expect(url.pathname).toBe(`/api/attachment-links/${ID}`);
    expect(url.searchParams.get("exp")).toBe(String(link.expiresAt));
    expect(url.searchParams.get("sig")).toBe(link.signature);
  });

  test("refuses to mint without a key, and says how to fix it", async () => {
    // The point of the message: minting is disabled rather than falling back to
    // an unsigned URL, and the reader is told which variable to set.
    await expect(
      signAttachmentLink(undefined, { id: ID, now: NOW })
    ).rejects.toThrow(NOT_CONFIGURED);
    await expect(signAttachmentLink("", { id: ID, now: NOW })).rejects.toThrow(
      NOT_CONFIGURED
    );
  });

  test("rejects a key that is not base64, or is the wrong length", async () => {
    await expect(
      signAttachmentLink("not base64 at all!", { id: ID, now: NOW })
    ).rejects.toThrow(NOT_BASE64);
    await expect(
      signAttachmentLink(btoa("x".repeat(31)), { id: ID, now: NOW })
    ).rejects.toThrow(WRONG_LENGTH);
  });
});

describe("verifying", () => {
  test("an expired link", async () => {
    const link = await sign(60);

    // One millisecond before the expiry it still works; on it, it does not.
    expect(
      await verifyAttachmentLink(KEY, {
        exp: String(link.expiresAt),
        id: ID,
        now: link.expiresAt * 1000 - 1,
        sig: link.signature,
      })
    ).toBe(true);
    expect(
      await verifyAttachmentLink(KEY, {
        exp: String(link.expiresAt),
        id: ID,
        now: link.expiresAt * 1000,
        sig: link.signature,
      })
    ).toBe(false);
    expect(
      await verifyAttachmentLink(KEY, {
        exp: String(link.expiresAt),
        id: ID,
        now: link.expiresAt * 1000 + 60_000,
        sig: link.signature,
      })
    ).toBe(false);
  });

  test("a tampered expiry", async () => {
    const link = await sign(60);

    // The whole reason the expiry is signed: a holder who could extend it would
    // have a permanent bearer token for that file.
    expect(
      await verifyAttachmentLink(KEY, {
        exp: String(link.expiresAt + 86_400),
        id: ID,
        now: NOW,
        sig: link.signature,
      })
    ).toBe(false);
  });

  test("a tampered id", async () => {
    const link = await sign(60);

    expect(
      await verifyAttachmentLink(KEY, {
        exp: String(link.expiresAt),
        id: "3f2a1b4c-0000-4000-8000-000000000002",
        now: NOW,
        sig: link.signature,
      })
    ).toBe(false);
  });

  test("an id that borrows digits from the expiry", async () => {
    // `id:exp` can only be split one way while `exp` is a plain digit string,
    // which is what stops a crafted id from re-splitting a valid signature.
    const link = await signAttachmentLink(KEY, {
      id: `${ID}:1`,
      now: NOW,
      ttlSeconds: 60,
    });

    expect(
      await verifyAttachmentLink(KEY, {
        exp: `1:${link.expiresAt}`,
        id: ID,
        now: NOW,
        sig: link.signature,
      })
    ).toBe(false);
  });

  test("a signature made with another key", async () => {
    const other = await signAttachmentLink(generateConnectorKey(), {
      id: ID,
      now: NOW,
      ttlSeconds: 60,
    });

    expect(
      await verifyAttachmentLink(KEY, {
        exp: String(other.expiresAt),
        id: ID,
        now: NOW,
        sig: other.signature,
      })
    ).toBe(false);
  });

  test("no signature, no expiry, and garbage in either", async () => {
    const link = await sign(60);
    const exp = String(link.expiresAt);
    const cases = [
      { exp, sig: undefined },
      { exp, sig: null },
      { exp, sig: "" },
      // Not base64url at all: this must answer false, not throw.
      { exp, sig: "###not base64###" },
      { exp: undefined, sig: link.signature },
      { exp: "", sig: link.signature },
      { exp: "not-a-number", sig: link.signature },
      { exp: "1.5e10", sig: link.signature },
      { exp: `-${exp}`, sig: link.signature },
      { exp: ` ${exp}`, sig: link.signature },
      { exp: `${exp}9999999999999999`, sig: link.signature },
    ];

    for (const each of cases) {
      expect(
        // biome-ignore lint/performance/noAwaitInLoops: one assertion per case
        await verifyAttachmentLink(KEY, { ...each, id: ID, now: NOW })
      ).toBe(false);
    }
  });

  test("no key at all", async () => {
    const link = await sign(60);

    // Fail-closed: with no key nothing could have been minted, so the reader
    // refuses rather than accepting anything.
    for (const key of [undefined, null, ""]) {
      expect(
        // biome-ignore lint/performance/noAwaitInLoops: one assertion per case
        await verifyAttachmentLink(key, {
          exp: String(link.expiresAt),
          id: ID,
          now: NOW,
          sig: link.signature,
        })
      ).toBe(false);
    }
  });
});

describe("clampLinkTtl", () => {
  test("absent, absurd and negative ttls become the default", () => {
    expect(clampLinkTtl(undefined)).toBe(DEFAULT_LINK_TTL_SECONDS);
    expect(clampLinkTtl(Number.NaN)).toBe(DEFAULT_LINK_TTL_SECONDS);
    expect(clampLinkTtl(Number.POSITIVE_INFINITY)).toBe(
      DEFAULT_LINK_TTL_SECONDS
    );
    expect(clampLinkTtl(0)).toBe(DEFAULT_LINK_TTL_SECONDS);
    expect(clampLinkTtl(-60)).toBe(DEFAULT_LINK_TTL_SECONDS);
  });

  test("anything past the cap is capped, not refused", () => {
    expect(clampLinkTtl(MAX_LINK_TTL_SECONDS + 1)).toBe(MAX_LINK_TTL_SECONDS);
    expect(clampLinkTtl(86_400)).toBe(MAX_LINK_TTL_SECONDS);
    expect(clampLinkTtl(90.7)).toBe(90);
  });
});
