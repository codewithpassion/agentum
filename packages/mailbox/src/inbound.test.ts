import { describe, expect, test } from "bun:test";
import {
  attachmentKey,
  BODY_TRUNCATED_MARKER,
  capBody,
  dedupeKeyFor,
  rawMimeKey,
  safeFilename,
} from "./inbound.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const SHA256_KEY = /^sha256:[0-9a-f]{64}$/;
const mailbox = { mailboxId: "mb1", workspaceId: "ws1" };

describe("capBody", () => {
  test("leaves short text alone", () => {
    expect(capBody("hello", 100)).toBe("hello");
  });

  test("cuts long ASCII text to fit and ends with the marker", () => {
    const result = capBody("a".repeat(500), 100);
    expect(encoder.encode(result).byteLength).toBeLessThanOrEqual(100);
    expect(result.endsWith(BODY_TRUNCATED_MARKER)).toBe(true);
  });

  test("never splits a multi-byte character", () => {
    for (const unit of ["é", "😀"]) {
      for (let maxBytes = 30; maxBytes <= 60; maxBytes += 1) {
        const result = capBody(unit.repeat(50), maxBytes);
        expect(encoder.encode(result).byteLength).toBeLessThanOrEqual(maxBytes);
        expect(result.includes("�")).toBe(false);
        expect(() => decoder.decode(encoder.encode(result))).not.toThrow();
      }
    }
  });
});

describe("dedupeKeyFor", () => {
  const raw = encoder.encode("some mail bytes");

  test("returns the message id without brackets", async () => {
    expect(await dedupeKeyFor({ messageId: "<abc@x.com>", raw })).toBe(
      "abc@x.com"
    );
  });

  test("hashes the raw bytes when there is no message id", async () => {
    const key = await dedupeKeyFor({ messageId: null, raw });
    expect(key).toMatch(SHA256_KEY);
  });

  test("hashes the raw bytes when the message id is empty", async () => {
    expect(await dedupeKeyFor({ messageId: "", raw })).toMatch(SHA256_KEY);
  });

  test("hashes the raw bytes when the message id is only brackets", async () => {
    expect(await dedupeKeyFor({ messageId: "<>", raw })).toMatch(SHA256_KEY);
  });

  test("gives the same hash for the same bytes and different hashes for different bytes", async () => {
    const first = await dedupeKeyFor({ messageId: null, raw });
    const same = await dedupeKeyFor({
      messageId: null,
      raw: encoder.encode("some mail bytes"),
    });
    const other = await dedupeKeyFor({
      messageId: null,
      raw: encoder.encode("other mail bytes"),
    });
    expect(same).toBe(first);
    expect(other).not.toBe(first);
  });
});

describe("safeFilename", () => {
  test("returns untitled for a missing or empty name", () => {
    expect(safeFilename(null)).toBe("untitled");
    expect(safeFilename(undefined)).toBe("untitled");
    expect(safeFilename("")).toBe("untitled");
  });

  test("replaces each forbidden character with an underscore", () => {
    expect(safeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe("a_b_c_d_e_f_g_h_i_j");
  });

  test("replaces control characters with an underscore", () => {
    expect(safeFilename("a\u0000b\u001fc\nd\te")).toBe("a_b_c_d_e");
  });

  test("replaces DEL with an underscore", () => {
    expect(safeFilename("a\u007fb")).toBe("a_b");
  });

  test("keeps ordinary names unchanged", () => {
    expect(safeFilename("report 2026-10.pdf")).toBe("report 2026-10.pdf");
  });

  test("caps a long name at 255 bytes without splitting a character", () => {
    expect(safeFilename("a".repeat(5000))).toBe("a".repeat(255));
    const capped = safeFilename("é".repeat(300));
    expect(encoder.encode(capped).byteLength).toBeLessThanOrEqual(255);
    expect(capped).toBe("é".repeat(127));
  });
});

describe("key builders", () => {
  test("rawMimeKey builds the raw message key", () => {
    expect(rawMimeKey(mailbox, "msg1")).toBe("ws1/mail/mb1/raw/msg1.eml");
  });

  test("attachmentKey builds the attachment key", () => {
    expect(attachmentKey(mailbox, "msg1", "att1", "invoice.pdf")).toBe(
      "ws1/mail/mb1/msg1/att1/invoice.pdf"
    );
  });
});
