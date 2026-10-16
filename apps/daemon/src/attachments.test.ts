import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractAttachmentMarkers,
  MAX_OUTBOUND_BYTES,
  rejectionNote,
  resolveOutboundFiles,
} from "./attachments.ts";

const SMALL_MAX_BYTES = 10;

let base: string;
let workDir: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "hm-attachments-"));
  workDir = join(base, "work");
  mkdirSync(workDir);
});

afterEach(() => {
  rmSync(base, { force: true, recursive: true });
});

const policy = (maxBytes = MAX_OUTBOUND_BYTES) => ({ maxBytes, workDir });

describe("extractAttachmentMarkers", () => {
  test("returns text unchanged when there is no marker", () => {
    const text = "plain reply\n\nwith   spacing ";
    expect(extractAttachmentMarkers(text)).toEqual({ paths: [], text });
  });

  test("collects paths in order and de-duplicates them", () => {
    const result = extractAttachmentMarkers(
      "[ATTACHMENT:a.png] and [ATTACHMENT:b.txt] then [ATTACHMENT:a.png]"
    );
    expect(result.paths).toEqual(["a.png", "b.txt"]);
  });

  test("keeps spaces inside a path and trims the edges", () => {
    const result = extractAttachmentMarkers(
      "see [ATTACHMENT:  my docs/report 1.pdf ]"
    );
    expect(result.paths).toEqual(["my docs/report 1.pdf"]);
  });

  test("removes markers and tidies the text around them", () => {
    const text =
      "Here it is [ATTACHMENT:x.png] ok\n[ATTACHMENT:y.png]\n\n\n\nDone  \n";
    expect(extractAttachmentMarkers(text).text).toBe("Here it is ok\n\nDone");
  });
});

describe("resolveOutboundFiles", () => {
  test("accepts a file inside workDir with its name, size and mime", () => {
    const file = join(workDir, "notes.txt");
    writeFileSync(file, "hello");

    const result = resolveOutboundFiles([file], policy());

    expect(result.rejected).toEqual([]);
    expect(result.files).toEqual([
      { mime: "text/plain", name: "notes.txt", path: file, size: 5 },
    ]);
  });

  test("resolves a relative path against workDir", () => {
    mkdirSync(join(workDir, "out"));
    writeFileSync(join(workDir, "out", "chart.png"), "png-bytes");

    const result = resolveOutboundFiles(["out/chart.png"], policy());

    expect(result.rejected).toEqual([]);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({
      mime: "image/png",
      name: "chart.png",
      path: join(workDir, "out", "chart.png"),
      size: 9,
    });
  });

  test("refuses a file outside workDir", () => {
    const outside = join(base, "secret.txt");
    writeFileSync(outside, "x");

    const result = resolveOutboundFiles([outside], policy());

    expect(result.files).toEqual([]);
    expect(result.rejected).toEqual([
      { name: "secret.txt", path: outside, reason: "outside_root" },
    ]);
  });

  test("refuses a symlink inside workDir that points outside it", () => {
    const outside = join(base, "target.txt");
    writeFileSync(outside, "x");
    const link = join(workDir, "link.txt");
    symlinkSync(outside, link);

    const result = resolveOutboundFiles([link], policy());

    expect(result.files).toEqual([]);
    expect(result.rejected).toEqual([
      { name: "link.txt", path: link, reason: "outside_root" },
    ]);
  });

  test("reports a directory as not_a_file", () => {
    const dir = join(workDir, "folder");
    mkdirSync(dir);

    const result = resolveOutboundFiles([dir], policy());

    expect(result.files).toEqual([]);
    expect(result.rejected).toEqual([
      { name: "folder", path: dir, reason: "not_a_file" },
    ]);
  });

  test("reports a missing file as missing", () => {
    const absent = join(workDir, "absent.txt");

    const result = resolveOutboundFiles([absent], policy());

    expect(result.files).toEqual([]);
    expect(result.rejected).toEqual([
      { name: "absent.txt", path: absent, reason: "missing" },
    ]);
  });

  test("refuses a file larger than maxBytes", () => {
    const big = join(workDir, "big.bin");
    writeFileSync(big, "0123456789A");

    const result = resolveOutboundFiles([big], policy(SMALL_MAX_BYTES));

    expect(result.files).toEqual([]);
    expect(result.rejected).toEqual([
      { name: "big.bin", path: big, reason: "too_large" },
    ]);
  });

  test("refuses every path when workDir does not exist", () => {
    const missingRoot = join(base, "nope");
    const result = resolveOutboundFiles(["a.txt"], {
      maxBytes: MAX_OUTBOUND_BYTES,
      workDir: missingRoot,
    });

    expect(result.files).toEqual([]);
    expect(result.rejected).toEqual([
      {
        name: "a.txt",
        path: join(missingRoot, "a.txt"),
        reason: "outside_root",
      },
    ]);
  });
});

describe("rejectionNote", () => {
  test("names missing and non-file rejections as missing", () => {
    expect(
      rejectionNote({ name: "a.txt", path: "/w/a.txt", reason: "missing" })
    ).toBe("[attachment missing: a.txt]");
    expect(
      rejectionNote({ name: "dir", path: "/w/dir", reason: "not_a_file" })
    ).toBe("[attachment missing: dir]");
  });

  test("names outside_root and too_large rejections as refused", () => {
    expect(
      rejectionNote({ name: "b.txt", path: "/x/b.txt", reason: "outside_root" })
    ).toBe("[attachment refused: b.txt]");
    expect(
      rejectionNote({ name: "c.bin", path: "/w/c.bin", reason: "too_large" })
    ).toBe("[attachment refused: c.bin]");
  });
});
