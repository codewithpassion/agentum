import { describe, expect, test } from "bun:test";
import {
  isInlineMimeType,
  MAX_ATTACHMENT_BYTES,
  MAX_BRIDGE_ATTACHMENT_BYTES,
  normalizeMimeType,
  sanitizeFilename,
  validateAttachment,
} from "./attachment-rules";

const validCandidate = {
  filename: "diagram.png",
  mime: "image/png",
  size: 1024,
};

describe("validateAttachment", () => {
  test("accepts an allowed image", () => {
    expect(validateAttachment(validCandidate)).toEqual({
      filename: "diagram.png",
      mime: "image/png",
      ok: true,
    });
  });

  test("accepts a mime type carrying parameters", () => {
    const result = validateAttachment({
      ...validCandidate,
      filename: "notes.txt",
      mime: "Text/Plain; charset=utf-8",
    });
    expect(result).toEqual({
      filename: "notes.txt",
      mime: "text/plain",
      ok: true,
    });
  });

  test("accepts an mp3 under either spelling", () => {
    for (const mime of ["audio/mpeg", "audio/mp3"]) {
      expect(
        validateAttachment({ ...validCandidate, filename: "call.mp3", mime })
      ).toEqual({ filename: "call.mp3", mime, ok: true });
    }
  });

  test("rejects a disallowed mime type", () => {
    const result = validateAttachment({
      ...validCandidate,
      filename: "logo.svg",
      mime: "image/svg+xml",
    });
    expect(result.ok).toBe(false);
  });

  test("rejects a file over the size limit", () => {
    const result = validateAttachment({
      ...validCandidate,
      size: MAX_ATTACHMENT_BYTES + 1,
    });
    expect(result).toEqual({
      ok: false,
      reason: "The file is larger than the 100MB limit.",
    });
  });

  test("accepts a file exactly at the size limit", () => {
    expect(
      validateAttachment({ ...validCandidate, size: MAX_ATTACHMENT_BYTES }).ok
    ).toBe(true);
  });

  /**
   * The bridge cap is the buffering callers' own business - `validateAttachment`
   * knows only the streaming limit, so a file between the two passes here and is
   * turned away earlier, by the bridge that would have to hold it in memory.
   */
  test("accepts a file the bridge cap would have refused", () => {
    expect(
      validateAttachment({
        ...validCandidate,
        size: MAX_BRIDGE_ATTACHMENT_BYTES + 1,
      }).ok
    ).toBe(true);
  });

  test("rejects an empty file", () => {
    expect(validateAttachment({ ...validCandidate, size: 0 }).ok).toBe(false);
  });

  test("rejects a blank filename", () => {
    expect(validateAttachment({ ...validCandidate, filename: "   " }).ok).toBe(
      false
    );
  });

  test("strips a directory component from the filename", () => {
    const result = validateAttachment({
      ...validCandidate,
      filename: "../../etc/passwd.png",
    });
    expect(result).toEqual({
      filename: "passwd.png",
      mime: "image/png",
      ok: true,
    });
  });
});

describe("sanitizeFilename", () => {
  test("removes quotes that would break Content-Disposition", () => {
    expect(sanitizeFilename('re"port.pdf')).toBe("report.pdf");
  });

  test("removes control characters", () => {
    expect(sanitizeFilename("re\u0000port.pdf")).toBe("report.pdf");
  });

  test("keeps a plain filename untouched", () => {
    expect(sanitizeFilename("annual report 2026.pdf")).toBe(
      "annual report 2026.pdf"
    );
  });
});

describe("normalizeMimeType", () => {
  test("lowercases and drops parameters", () => {
    expect(normalizeMimeType("IMAGE/PNG; foo=bar")).toBe("image/png");
  });
});

describe("isInlineMimeType", () => {
  test("is true for images", () => {
    expect(isInlineMimeType("image/jpeg")).toBe(true);
  });

  test("is false for documents", () => {
    expect(isInlineMimeType("application/pdf")).toBe(false);
  });
});
