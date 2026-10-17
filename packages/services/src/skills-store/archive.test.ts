// biome-ignore-all lint/suspicious/noBitwiseOperators: builds unix mode bits for zip attributes
import { describe, expect, test } from "bun:test";
import { zipSync } from "fflate";
import { ServiceError } from "../errors.ts";
import {
  type ArchiveFile,
  type ArchiveLimits,
  packArchive,
  unpackArchive,
} from "./archive.ts";

const LIMITS: ArchiveLimits = { maxBytes: 1024 * 1024, maxFiles: 100 };
const MTIME = new Date("2026-01-02T03:04:06Z");
const SKILL_MD = new TextEncoder().encode("---\nname: demo\n---\n");
const MB = 1024 * 1024;

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

const sortByPath = (files: readonly ArchiveFile[]): ArchiveFile[] =>
  [...files].sort((a, b) => (a.path < b.path ? -1 : 1));

const refusalOf = (run: () => unknown): ServiceError => {
  try {
    run();
  } catch (error) {
    if (error instanceof ServiceError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the archive to be refused");
};

const expectInvalid = (run: () => unknown, fragment: string): void => {
  const error = refusalOf(run);
  if (error.code !== "invalid" || !error.message.includes(fragment)) {
    throw new Error(
      `expected an invalid refusal containing "${fragment}", got ${error.code}: ${error.message}`
    );
  }
};

const HEADERS = {
  central: { fixed: 46, nameLength: 28, signature: 0x02_01_4b_50, size: 24 },
  local: { fixed: 30, nameLength: 26, signature: 0x04_03_4b_50, size: 22 },
} as const;

const locate = (
  zip: Uint8Array,
  header: (typeof HEADERS)[keyof typeof HEADERS],
  name: string
): number => {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const target = text(name);
  for (let at = 0; at + header.fixed <= zip.length; at += 1) {
    if (view.getUint32(at, true) !== header.signature) {
      continue;
    }
    const length = view.getUint16(at + header.nameLength, true);
    const candidate = zip.subarray(
      at + header.fixed,
      at + header.fixed + length
    );
    if (
      candidate.length === target.length &&
      candidate.every((byte, index) => byte === target[index])
    ) {
      return at;
    }
  }
  throw new Error(`no header for ${name}`);
};

const setDeclaredSize = (zip: Uint8Array, name: string, size: number): void => {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  view.setUint32(
    locate(zip, HEADERS.local, name) + HEADERS.local.size,
    size,
    true
  );
  view.setUint32(
    locate(zip, HEADERS.central, name) + HEADERS.central.size,
    size,
    true
  );
};

describe("packArchive and unpackArchive", () => {
  const binary = Uint8Array.from(
    { length: 4096 },
    (_, index) => (index * 37 + 11) % 256
  );
  const files: ArchiveFile[] = [
    { bytes: SKILL_MD, executable: false, path: "SKILL.md" },
    { bytes: text("# Reference"), executable: false, path: "references/a.md" },
    {
      bytes: text("#!/bin/sh\necho hi\n"),
      executable: true,
      path: "scripts/run.sh",
    },
    { bytes: binary, executable: false, path: "assets/img/pixel.bin" },
  ];

  test("round trip keeps paths, bytes and executable flags", () => {
    const zip = packArchive("demo", files, MTIME);
    const unpacked = unpackArchive(zip, LIMITS);
    expect(unpacked.folder).toBe("demo");
    expect(unpacked.files).toEqual(sortByPath(files));
  });

  test("the same input packs to identical bytes in any order", () => {
    const first = packArchive("demo", files, MTIME);
    const second = packArchive("demo", files, MTIME);
    const reversed = packArchive("demo", [...files].reverse(), MTIME);
    expect(second).toEqual(first);
    expect(reversed).toEqual(first);
  });

  test("a zip without unix attributes is not executable", () => {
    const zip = zipSync({
      "demo/SKILL.md": SKILL_MD,
      "demo/scripts/run.sh": text("echo hi"),
    });
    const unpacked = unpackArchive(zip, LIMITS);
    const run = unpacked.files.find((file) => file.path === "scripts/run.sh");
    expect(run?.executable).toBe(false);
  });

  test("macOS junk and directory entries are skipped", () => {
    const zip = zipSync({
      "__MACOSX/x/._SKILL.md": text("junk"),
      "demo/references/": new Uint8Array(0),
      "demo/references/a.md": text("# A"),
      "demo/SKILL.md": SKILL_MD,
      "demo/x/.DS_Store": text("junk"),
    });
    const unpacked = unpackArchive(zip, LIMITS);
    expect(unpacked.files.map((file) => file.path).sort()).toEqual([
      "SKILL.md",
      "references/a.md",
    ]);
  });
});

describe("unpackArchive refusals", () => {
  test("random bytes are not a zip", () => {
    const bytes = Uint8Array.from(
      { length: 300 },
      (_, index) => (index * 7) % 251
    );
    expectInvalid(() => unpackArchive(bytes, LIMITS), "not a valid zip");
  });

  test("a truncated zip is refused", () => {
    const zip = zipSync({ "demo/SKILL.md": SKILL_MD });
    expectInvalid(
      () => unpackArchive(zip.slice(0, zip.length - 10), LIMITS),
      "not a valid zip"
    );
  });

  test("an empty archive is refused", () => {
    expectInvalid(() => unpackArchive(zipSync({}), LIMITS), "no files");
  });

  test("a file at the root is refused", () => {
    const zip = zipSync({ "SKILL.md": SKILL_MD });
    expectInvalid(() => unpackArchive(zip, LIMITS), "file at its root");
  });

  test("two top-level folders are refused", () => {
    const zip = zipSync({
      "one/SKILL.md": SKILL_MD,
      "two/notes.md": text("x"),
    });
    expectInvalid(() => unpackArchive(zip, LIMITS), "more than one top-level");
  });

  test("a missing SKILL.md is refused", () => {
    const zip = zipSync({ "demo/references/a.md": text("x") });
    expectInvalid(() => unpackArchive(zip, LIMITS), "SKILL.md is missing");
  });

  test("a parent segment in the name is refused", () => {
    const zip = zipSync({ "demo/../SKILL.md": SKILL_MD });
    expectInvalid(() => unpackArchive(zip, LIMITS), "name is unsafe");
  });

  test("an absolute name is refused", () => {
    const zip = zipSync({ "/demo/SKILL.md": SKILL_MD });
    expectInvalid(() => unpackArchive(zip, LIMITS), "name is unsafe");
  });

  test("a backslash in the name is refused", () => {
    const zip = zipSync({
      "demo/SKILL.md": SKILL_MD,
      "demo\\other.md": text("x"),
    });
    expectInvalid(() => unpackArchive(zip, LIMITS), "name is unsafe");
  });

  test("a symlink entry is refused", () => {
    const zip = zipSync({
      "demo/link": [
        text("SKILL.md"),
        { attrs: (0o12_0777 << 16) >>> 0, os: 3 },
      ],
      "demo/SKILL.md": SKILL_MD,
    });
    expectInvalid(() => unpackArchive(zip, LIMITS), "symlink");
  });

  test("too many files are refused before inflating", () => {
    const zip = zipSync({
      "demo/a.md": text("a"),
      "demo/b.md": text("b"),
      "demo/SKILL.md": SKILL_MD,
    });
    expectInvalid(
      () => unpackArchive(zip, { maxBytes: MB, maxFiles: 2 }),
      "too big when unpacked: more than 2 files"
    );
  });

  test("a declared size over the limit is refused before inflating", () => {
    const zip = zipSync({
      "demo/a.md": new Uint8Array(100),
      "demo/SKILL.md": SKILL_MD,
    });
    expectInvalid(
      () => unpackArchive(zip, { maxBytes: 10, maxFiles: 10 }),
      "too big when unpacked: more than 10 bytes"
    );
  });

  test("a real zip bomb with an honest header is refused", () => {
    const bomb = zipSync({
      "demo/big.bin": new Uint8Array(20 * MB),
      "demo/SKILL.md": SKILL_MD,
    });
    expect(bomb.length).toBeLessThan(MB);
    expectInvalid(
      () => unpackArchive(bomb, { maxBytes: MB, maxFiles: 10 }),
      "too big when unpacked"
    );
  });

  test("a zip bomb with its declared sizes shrunk is stopped while inflating", () => {
    const bomb = zipSync({
      "demo/big.bin": new Uint8Array(20 * MB),
      "demo/SKILL.md": SKILL_MD,
    });
    setDeclaredSize(bomb, "demo/big.bin", 10);
    expectInvalid(
      () => unpackArchive(bomb, { maxBytes: MB, maxFiles: 10 }),
      "too big when unpacked: more than 1048576 bytes"
    );
  });
});
