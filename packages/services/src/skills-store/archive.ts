// biome-ignore-all lint/suspicious/noBitwiseOperators: zip headers are little-endian bit fields
import { Inflate, type ZipOptions, type Zippable, zipSync } from "fflate";
import { ServiceError } from "../errors.ts";

export interface ArchiveFile {
  bytes: Uint8Array;
  executable: boolean;
  path: string;
}

export interface UnpackedArchive {
  files: ArchiveFile[];
  folder: string;
}

export interface ArchiveLimits {
  maxBytes: number;
  maxFiles: number;
}

const LOCAL_SIGNATURE = 0x04_03_4b_50;
const CENTRAL_SIGNATURE = 0x02_01_4b_50;
const END_SIGNATURE = 0x06_05_4b_50;
const END_RECORD_SIZE = 22;
const END_SEARCH_SIZE = 65_557;
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_HEADER_SIZE = 30;
const ZIP64_MARK = 0xff_ff_ff_ff;
const ZIP64_COUNT = 0xff_ff;
const ENCRYPTED_FLAG = 1;
const STORED = 0;
const DEFLATE = 8;
const UNIX_HOST = 3;
const UNIX_TYPE_MASK = 0o17_0000;
const UNIX_SYMLINK = 0o12_0000;
const UNIX_EXEC_BITS = 0o111;
// Small, so one push can expand to a few MB at most (deflate stops at about 1000 to 1).
const CHUNK_SIZE = 4 * 1024;
const PACK_LEVEL = 6;
const SKILL_FILE = "SKILL.md";
const MACOS_FOLDER = "__MACOSX/";
const DS_STORE = ".DS_Store";
const UNSAFE_NAME = /\p{Cc}/u;
const DRIVE_PREFIX = /^[A-Za-z]:/;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

interface Entry {
  attrs: number;
  compressedSize: number;
  flags: number;
  host: number;
  localOffset: number;
  method: number;
  name: string;
  size: number;
}

const refuse = (message: string): never => {
  throw new ServiceError("invalid", message);
};

const NOT_ZIP = "Skill file is not a valid zip archive or is truncated";

const tooManyFiles = (limits: ArchiveLimits): never =>
  refuse(
    `Skill archive is too big when unpacked: more than ${limits.maxFiles} files`
  );

const tooManyBytes = (limits: ArchiveLimits): never =>
  refuse(
    `Skill archive is too big when unpacked: more than ${limits.maxBytes} bytes`
  );

const ensure = (condition: boolean): void => {
  if (!condition) {
    refuse(NOT_ZIP);
  }
};

const findEndRecord = (view: DataView): number => {
  const earliest = Math.max(0, view.byteLength - END_SEARCH_SIZE);
  for (let at = view.byteLength - END_RECORD_SIZE; at >= earliest; at -= 1) {
    if (view.getUint32(at, true) === END_SIGNATURE) {
      return at;
    }
  }
  return refuse(NOT_ZIP);
};

const decodeName = (bytes: Uint8Array): string => {
  try {
    return UTF8.decode(bytes);
  } catch {
    return refuse("Skill archive entry name is not valid UTF-8");
  }
};

const readCentralDirectory = (zip: Uint8Array, view: DataView): Entry[] => {
  const end = findEndRecord(view);
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const offset = view.getUint32(end + 16, true);
  if (
    count === ZIP64_COUNT ||
    directorySize === ZIP64_MARK ||
    offset === ZIP64_MARK
  ) {
    refuse("Skill archive uses zip64, which is not supported");
  }
  const limit = offset + directorySize;
  ensure(limit <= end);
  const entries: Entry[] = [];
  let position = offset;
  for (let index = 0; index < count; index += 1) {
    const nameStart = position + CENTRAL_HEADER_SIZE;
    ensure(nameStart <= limit);
    ensure(view.getUint32(position, true) === CENTRAL_SIGNATURE);
    const nameLength = view.getUint16(position + 28, true);
    const nameEnd = nameStart + nameLength;
    ensure(nameEnd <= limit);
    const flags = view.getUint16(position + 8, true);
    const method = view.getUint16(position + 10, true);
    const compressedSize = view.getUint32(position + 20, true);
    const size = view.getUint32(position + 24, true);
    const localOffset = view.getUint32(position + 42, true);
    if (
      compressedSize === ZIP64_MARK ||
      size === ZIP64_MARK ||
      localOffset === ZIP64_MARK
    ) {
      refuse("Skill archive uses zip64, which is not supported");
    }
    if ((flags & ENCRYPTED_FLAG) !== 0) {
      refuse("Skill archive is encrypted");
    }
    if (method !== STORED && method !== DEFLATE) {
      refuse("Skill archive uses an unsupported compression method");
    }
    entries.push({
      attrs: view.getUint32(position + 38, true),
      compressedSize,
      flags,
      host: view.getUint16(position + 4, true) >>> 8,
      localOffset,
      method,
      name: decodeName(zip.subarray(nameStart, nameEnd)),
      size,
    });
    position =
      nameEnd +
      view.getUint16(position + 30, true) +
      view.getUint16(position + 32, true);
  }
  return entries;
};

const isJunk = (name: string): boolean =>
  name.endsWith("/") ||
  name.startsWith(MACOS_FOLDER) ||
  name.split("/").at(-1) === DS_STORE;

const checkName = (name: string): void => {
  const segments = name.split("/");
  const unsafe =
    name.startsWith("/") ||
    DRIVE_PREFIX.test(name) ||
    name.includes("\\") ||
    UNSAFE_NAME.test(name) ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === ".."
    );
  if (unsafe) {
    refuse(`Skill archive entry name is unsafe: ${JSON.stringify(name)}`);
  }
};

const isSymlink = (entry: Entry): boolean =>
  entry.host === UNIX_HOST &&
  ((entry.attrs >>> 16) & UNIX_TYPE_MASK) === UNIX_SYMLINK;

const isExecutable = (entry: Entry): boolean =>
  entry.host === UNIX_HOST && ((entry.attrs >>> 16) & UNIX_EXEC_BITS) !== 0;

const dataStart = (zip: Uint8Array, view: DataView, entry: Entry): number => {
  const at = entry.localOffset;
  ensure(at + LOCAL_HEADER_SIZE <= zip.length);
  ensure(view.getUint32(at, true) === LOCAL_SIGNATURE);
  const start =
    at +
    LOCAL_HEADER_SIZE +
    view.getUint16(at + 26, true) +
    view.getUint16(at + 28, true);
  ensure(start + entry.compressedSize <= zip.length);
  return start;
};

const concat = (chunks: Uint8Array[], length: number): Uint8Array => {
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};

const sizeMismatch = (name: string): never =>
  refuse(`Skill archive entry size does not match its header: ${name}`);

const readFile = (
  zip: Uint8Array,
  view: DataView,
  entry: Entry,
  addBytes: (count: number) => void
): Uint8Array => {
  const start = dataStart(zip, view, entry);
  const compressed = zip.subarray(start, start + entry.compressedSize);
  if (entry.method === STORED) {
    if (entry.compressedSize !== entry.size) {
      sizeMismatch(entry.name);
    }
    addBytes(entry.size);
    return compressed.slice();
  }

  const chunks: Uint8Array[] = [];
  let produced = 0;
  const inflater = new Inflate((chunk) => {
    addBytes(chunk.length);
    chunks.push(chunk.slice());
    produced += chunk.length;
  });
  const last = Math.max(0, Math.ceil(compressed.length / CHUNK_SIZE) - 1);
  try {
    for (let index = 0; index <= last; index += 1) {
      inflater.push(
        compressed.subarray(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE),
        index === last
      );
    }
  } catch (error) {
    if (error instanceof ServiceError) {
      throw error;
    }
    refuse(`Skill archive entry is corrupt: ${entry.name}`);
  }
  if (produced !== entry.size) {
    sizeMismatch(entry.name);
  }
  return concat(chunks, produced);
};

/**
 * Reads a `.skill` zip. Refuses with an `invalid` ServiceError on any unsafe,
 * unsupported or oversized content. Limits apply to the unpacked content.
 */
export const unpackArchive = (
  zip: Uint8Array,
  limits: ArchiveLimits
): UnpackedArchive => {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const kept = readCentralDirectory(zip, view).filter(
    (entry) => !isJunk(entry.name)
  );
  if (kept.length === 0) {
    refuse("Skill archive has no files");
  }
  for (const entry of kept) {
    checkName(entry.name);
    if (isSymlink(entry)) {
      refuse(`Skill archive contains a symlink: ${JSON.stringify(entry.name)}`);
    }
  }

  const splits = kept.map((entry) => entry.name.split("/"));
  for (const entry of kept) {
    if (!entry.name.includes("/")) {
      refuse(
        `Skill archive has a file at its root: ${JSON.stringify(entry.name)}`
      );
    }
  }
  const folders = new Set(splits.map((segments) => segments[0]));
  if (folders.size > 1) {
    refuse("Skill archive has more than one top-level folder");
  }
  const folder = [...folders][0] ?? refuse("Skill archive has no files");

  const paths = kept.map((entry) => entry.name.slice(folder.length + 1));
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) {
      refuse(`Skill archive has a duplicate path: ${JSON.stringify(path)}`);
    }
    seen.add(path);
  }
  if (!seen.has(SKILL_FILE)) {
    refuse("SKILL.md is missing from the skill archive");
  }

  if (kept.length > limits.maxFiles) {
    tooManyFiles(limits);
  }
  const declared = kept.reduce((sum, entry) => sum + entry.size, 0);
  if (declared > limits.maxBytes) {
    tooManyBytes(limits);
  }

  let total = 0;
  const addBytes = (count: number): void => {
    total += count;
    if (total > limits.maxBytes) {
      tooManyBytes(limits);
    }
  };
  const files = kept.map((entry, index) => ({
    bytes: readFile(zip, view, entry, addBytes),
    executable: isExecutable(entry),
    path: paths[index] ?? "",
  }));
  return { files, folder };
};

const compareCodeUnits = (a: string, b: string): number => {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};

/**
 * Builds a `.skill` zip with every file under `<folder>/`. Output depends only
 * on the input: files are sorted by path and no directory entries are added.
 */
export const packArchive = (
  folder: string,
  files: readonly ArchiveFile[],
  mtime: Date
): Uint8Array => {
  const entries: Zippable = {};
  const sorted = [...files].sort((a, b) => compareCodeUnits(a.path, b.path));
  for (const file of sorted) {
    const mode = file.executable ? 0o10_0755 : 0o10_0644;
    const options: ZipOptions = {
      attrs: (mode << 16) >>> 0,
      level: PACK_LEVEL,
      mtime,
      os: UNIX_HOST,
    };
    entries[`${folder}/${file.path}`] = [file.bytes, options];
  }
  return zipSync(entries);
};
