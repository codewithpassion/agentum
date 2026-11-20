import {
  MEMORY_NOTE_KINDS,
  MEMORY_NOTE_MAX_CHARS,
  MEMORY_SOURCE_KINDS,
  MEMORY_WRITERS,
  type MemoryNote,
  type MemoryNoteKind,
  type MemorySource,
  type MemoryWriter,
} from "@repo/db/shared";

/** Paths are relative to agents/<slug>/memory/. index.md is generated. */
export type MemoryFiles = Record<string, string>;
export interface MemoryProblem {
  line: number;
  message: string;
}
export type MemoryParseResult =
  | { ok: true; notes: MemoryNote[] }
  | { ok: false; problems: MemoryProblem[] };

export class MemoryCodecError extends Error {
  readonly path: string;
  readonly line: number;

  constructor(path: string, line: number, message: string) {
    super(`${path}:${line}: ${message}`);
    this.name = "MemoryCodecError";
    this.path = path;
    this.line = line;
  }
}

const ORDER: readonly MemoryNoteKind[] = [
  "corrections",
  "people",
  "places",
  "work",
];
const TITLES: Record<MemoryNoteKind, string> = {
  corrections: "Corrections",
  people: "People",
  places: "Places",
  work: "Work",
};
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i;
// ULIDs are case insensitive; preserve spelling in files, fold only for identity.
const noteKey = (id: string): string => id.toUpperCase();
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PRIVATE_PATH = /^private\/(user_[A-Za-z0-9]+)\.md$/;
const WHITESPACE_RUN = /\s+/g;
const SOURCE = /^([^:]+):([^\s]+)$/;

interface FileInfo {
  kind: MemoryNoteKind | null;
  title: string;
  userScope: string | null;
}
const fileInfo = (path: string): FileInfo => {
  for (const kind of MEMORY_NOTE_KINDS) {
    if (path === `${kind}.md`) {
      return { kind, title: `# ${TITLES[kind]}`, userScope: null };
    }
  }
  const match = PRIVATE_PATH.exec(path);
  if (match?.[1]) {
    return { kind: null, title: "# Private notes", userScope: match[1] };
  }
  throw new MemoryCodecError(
    path,
    1,
    "Expected a kind.md or private/<userId>.md path"
  );
};

function fail(path: string, line: number, message: string): never {
  throw new MemoryCodecError(path, line, message);
}
const validDate = (date: string): boolean =>
  DATE.test(date) &&
  Number.isFinite(Date.parse(`${date}T00:00:00Z`)) &&
  new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;

// Source ids follow the service's opaque, nonempty id rule, not the note ULID
// rule. Whitespace is refused because this field must occupy one line.
const readSource = (
  path: string,
  line: number,
  value: string
): MemorySource | null => {
  if (value === "none") {
    return null;
  }
  const match = SOURCE.exec(value);
  const kind = MEMORY_SOURCE_KINDS.find(
    (candidate) => candidate === match?.[1]
  );
  if (!(kind && match?.[2])) {
    return fail(
      path,
      line,
      "Expected none or session:<id>, run:<id>, request:<id>"
    );
  }
  return { id: match[2], kind };
};

const readFile = (path: string, text: string): MemoryNote[] => {
  const info = fileInfo(path);
  // Canonical files use LF and exactly one final newline. Reject rather than
  // silently repairing line endings; library edits must be explicitly fixed.
  const carriage = text.indexOf("\r");
  if (carriage !== -1) {
    fail(
      path,
      text.slice(0, carriage).split("\n").length,
      "Expected LF line endings"
    );
  }
  if (!text.endsWith("\n")) {
    fail(path, text.split("\n").length, "Expected final newline");
  }
  const lines = text.slice(0, -1).split("\n");
  if (!lines[0]) {
    fail(path, 1, "Expected title line");
  }
  if (lines.length === 1) {
    return [];
  }
  if (lines[1] !== "") {
    fail(path, 2, "Expected blank line after title");
  }
  const notes: MemoryNote[] = [];
  const ids = new Set<string>();
  let cursor = 2;
  do {
    const idLine = cursor + 1;
    const block = readBlock(path, info, lines, cursor);
    if (ids.has(noteKey(block.note.id))) {
      fail(path, idLine, `Duplicate note id ${block.note.id}`);
    }
    ids.add(noteKey(block.note.id));
    notes.push(block.note);
    ({ cursor } = block);
    if (cursor === lines.length) {
      break;
    }
    if (lines[cursor] !== "" || cursor === lines.length - 1) {
      fail(
        path,
        cursor + 1,
        "Expected one blank line between notes and no trailing content"
      );
    }
    cursor += 1;
  } while (cursor <= lines.length);
  return notes;
};

const readBlock = (
  path: string,
  info: FileInfo,
  lines: string[],
  start: number
): { note: MemoryNote; cursor: number } => {
  let cursor = start;
  const field = (key: string, first = false): string => {
    const prefix = `${first ? "- " : "  "}${key}: `;
    const line = lines[cursor];
    if (!line?.startsWith(prefix)) {
      fail(path, cursor + 1, `Expected ${key} field`);
    }
    cursor += 1;
    return line.slice(prefix.length);
  };
  const id = field("id", true);
  if (!ULID.test(id)) {
    fail(path, start + 1, "Expected a 26 character ULID");
  }
  let { kind } = info;
  if (info.userScope !== null) {
    const kindLine = cursor + 1;
    const value = field("kind");
    kind = MEMORY_NOTE_KINDS.find((candidate) => candidate === value) ?? null;
    if (!kind) {
      fail(path, kindLine, "Unknown note kind");
    }
  }
  const dateLine = cursor + 1;
  const date = field("date");
  if (!validDate(date)) {
    fail(path, dateLine, "Expected a valid YYYY-MM-DD date");
  }
  const sourceLine = cursor + 1;
  const source = readSource(path, sourceLine, field("source"));
  const byLine = cursor + 1;
  const by = field("by");
  const writtenBy = MEMORY_WRITERS.find((candidate) => candidate === by);
  if (!writtenBy) {
    fail(path, byLine, "Unknown note writer");
  }
  const textLine = cursor + 1;
  const value = field("text");
  if (
    !value ||
    value.length > MEMORY_NOTE_MAX_CHARS ||
    value.trim() !== value
  ) {
    fail(
      path,
      textLine,
      `Expected 1 to ${MEMORY_NOTE_MAX_CHARS} characters without surrounding whitespace`
    );
  }
  return {
    cursor,
    note: {
      date,
      id,
      kind: kind as MemoryNoteKind,
      source,
      text: value,
      userScope: info.userScope,
      writtenBy,
    },
  };
};

/** A malformed file returns problems only; no prefix of its notes is accepted. */
export const parseMemoryFile = (
  path: string,
  text: string
): MemoryParseResult => {
  try {
    return { notes: readFile(path, text), ok: true };
  } catch (error) {
    if (!(error instanceof MemoryCodecError)) {
      throw error;
    }
    return {
      ok: false,
      problems: [
        {
          line: error.line,
          message: error.message.slice(`${path}:${error.line}: `.length),
        },
      ],
    };
  }
};

/** Matches service.ts: collapse whitespace, trim, then count JS characters. */
const normalizeText = (text: string): string =>
  text.replace(WHITESPACE_RUN, " ").trim();

/**
 * Retains file/insertion order (oldest first); edits keep their position even
 * though their date changes. Canonical format examples round trip byte for byte.
 * Hand-edited whitespace runs are accepted on read and normalized on write.
 */
export const serializeMemoryFile = (
  path: string,
  notes: readonly MemoryNote[]
): string => {
  const info = fileInfo(path);
  const blocks = notes.map((note, index) => {
    if (
      note.userScope !== info.userScope ||
      (info.kind !== null && note.kind !== info.kind)
    ) {
      return fail(
        path,
        3 + index * (info.kind ? 7 : 8),
        "Note does not belong to this file"
      );
    }
    const fields = [`- id: ${note.id}`];
    if (info.userScope !== null) {
      fields.push(`  kind: ${note.kind}`);
    }
    fields.push(
      `  date: ${note.date}`,
      `  source: ${note.source ? `${note.source.kind}:${note.source.id}` : "none"}`,
      `  by: ${note.writtenBy}`,
      `  text: ${normalizeText(note.text)}`
    );
    return fields.join("\n");
  });
  const text = `${info.title}${blocks.length ? `\n\n${blocks.join("\n\n")}` : ""}\n`;
  // Validate typed callers too, so invalid metadata can never be written.
  readFile(path, text);
  return text;
};

const newestFirst = (notes: readonly MemoryNote[]): MemoryNote[] =>
  notes
    .map((note, index) => ({ index, note }))
    .sort((a, b) => b.note.date.localeCompare(a.note.date) || b.index - a.index)
    .map((item) => item.note);

export const buildIndex = (notes: readonly MemoryNote[]): string => {
  const sections = ORDER.flatMap((kind) => {
    const entries = newestFirst(
      notes.filter((note) => note.kind === kind && note.userScope === null)
    );
    if (!entries.length) {
      return [];
    }
    const list = entries.map((note) => {
      const text =
        note.text.length > 80
          ? `${note.text.slice(0, 80).trimEnd()}...`
          : note.text;
      return `- ${note.id}: ${text}`;
    });
    return [`## ${TITLES[kind]} (${entries.length})\n\n${list.join("\n")}`];
  });
  return `# Memory index${sections.length ? `\n\n${sections.join("\n\n")}` : ""}\n`;
};

interface NoteEdit {
  date: string;
  noteId: string;
  text: string;
  writtenBy: MemoryWriter;
}
export type MemoryFileChange =
  | { action: "add"; note: MemoryNote }
  | ({ action: "edit" } & NoteEdit)
  | { action: "forget"; noteId: string }
  | ({ action: "merge"; absorbedIds: readonly string[] } & NoteEdit);

const pathOf = (note: MemoryNote): string =>
  note.userScope === null ? `${note.kind}.md` : `private/${note.userScope}.md`;

interface NoteLocation {
  line: number;
  note: MemoryNote;
  path: string;
}

const loadFiles = (files: Readonly<MemoryFiles>) => {
  const contents = new Map<string, MemoryNote[]>();
  const locations = new Map<string, NoteLocation>();
  // Index rebuilding and global id uniqueness depend on every note file, so
  // conservatively refuse a change if any supplied note file is malformed.
  for (const [path, text] of Object.entries(files)) {
    if (path === "index.md") {
      continue;
    }
    const notes = readFile(path, text);
    contents.set(path, notes);
    const privateFile = fileInfo(path).userScope !== null;
    for (const [index, note] of notes.entries()) {
      const line = 3 + index * (privateFile ? 8 : 7);
      const previous = locations.get(noteKey(note.id));
      if (previous) {
        fail(
          path,
          line,
          `Duplicate note id ${note.id} (also ${previous.path}:${previous.line})`
        );
      }
      locations.set(noteKey(note.id), { line, note, path });
    }
  }
  return { contents, locations };
};

const removedIds = (
  change: Exclude<MemoryFileChange, { action: "add" }>,
  target: NoteLocation,
  locations: Map<string, NoteLocation>
): Set<string> => {
  if (change.action === "forget") {
    return new Set([noteKey(change.noteId)]);
  }
  const removed = new Set<string>();
  if (change.action === "merge") {
    if (!change.absorbedIds.length) {
      fail(
        target.path,
        target.line,
        "Merge requires at least one absorbed note"
      );
    }
    for (const id of change.absorbedIds) {
      if (
        noteKey(id) === noteKey(change.noteId) ||
        removed.has(noteKey(id)) ||
        !locations.has(noteKey(id))
      ) {
        fail(target.path, target.line, `Invalid absorbed note id ${id}`);
      }
      removed.add(noteKey(id));
    }
  }
  return removed;
};

/** Atomic pure change: throws MemoryCodecError with path/line; never mutates files. */
export const apply = (
  files: Readonly<MemoryFiles>,
  change: MemoryFileChange
): MemoryFiles => {
  const { contents, locations } = loadFiles(files);
  const touched = new Set<string>();
  if (change.action === "add") {
    const path = pathOf(change.note);
    const existing = locations.get(noteKey(change.note.id));
    if (existing) {
      fail(existing.path, existing.line, `Duplicate note id ${change.note.id}`);
    }
    contents.set(path, [...(contents.get(path) ?? []), change.note]);
    touched.add(path);
  } else {
    const target = locations.get(noteKey(change.noteId));
    if (!target) {
      // No file exists for a missing id; use the memory root and line 1.
      fail(".", 1, `Unknown note id ${change.noteId}`);
    }
    const removed = removedIds(change, target, locations);
    for (const [path, notes] of contents) {
      const updated = notes.flatMap((note) => {
        if (removed.has(noteKey(note.id))) {
          touched.add(path);
          return [];
        }
        if (
          noteKey(note.id) === noteKey(change.noteId) &&
          change.action !== "forget"
        ) {
          touched.add(path);
          return [
            {
              ...note,
              date: change.date,
              text: change.text,
              writtenBy: change.writtenBy,
            },
          ];
        }
        return [note];
      });
      contents.set(path, updated);
    }
  }
  const result = { ...files };
  for (const path of touched) {
    const text = serializeMemoryFile(path, contents.get(path) ?? []);
    result[path] = text;
    // Index uses the same normalized text that was persisted.
    contents.set(path, readFile(path, text));
  }
  result["index.md"] = buildIndex([...contents.values()].flat());
  return result;
};

/**
 * Counts note text only; prompt formatting belongs to the caller. Oversized
 * notes are skipped whole, allowing a later smaller note to fill the remainder.
 */
export const budget = (
  notes: readonly MemoryNote[],
  maxChars: number
): MemoryNote[] => {
  if (!Number.isFinite(maxChars) || maxChars < 0) {
    throw new RangeError("maxChars must be finite and nonnegative");
  }
  const selected: MemoryNote[] = [];
  let remaining = maxChars;
  for (const kind of ORDER) {
    for (const note of newestFirst(
      notes.filter((candidate) => candidate.kind === kind)
    )) {
      if (note.text.length <= remaining) {
        selected.push(note);
        remaining -= note.text.length;
      }
    }
  }
  return selected;
};

export { apply as applyMemoryChange, budget as budgetNotes };
