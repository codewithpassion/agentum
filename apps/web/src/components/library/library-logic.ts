import { TRPCClientError } from "@trpc/client";

export interface Crumb {
  name: string;
  /** Library path of the folder, no leading slash. The root is "". */
  path: string;
}

const KIB = 1024;
const SIZE_UNITS = ["B", "KB", "MB", "GB"] as const;

/** `docs/notes` + `a.md` -> `docs/notes/a.md`. The root is the empty string. */
export const joinPath = (dir: string, name: string): string =>
  dir === "" ? name : `${dir}/${name}`;

/** The folder holding a path. The parent of a top-level name is the root. */
export const parentDir = (path: string): string => {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
};

/** The last segment of a path. */
export const baseName = (path: string): string =>
  path.slice(path.lastIndexOf("/") + 1);

/** One crumb per folder from the root down to `dir`, the root first. */
export const breadcrumbs = (dir: string): Crumb[] => {
  const crumbs: Crumb[] = [{ name: "Library", path: "" }];
  let path = "";
  for (const name of dir.split("/").filter((part) => part !== "")) {
    path = joinPath(path, name);
    crumbs.push({ name, path });
  }
  return crumbs;
};

/** `1536` -> `1.5 KB`. Whole bytes below 1 KB. */
export const formatSize = (bytes: number): string => {
  let value = bytes;
  let unit = 0;
  while (value >= KIB && unit < SIZE_UNITS.length - 1) {
    value /= KIB;
    unit += 1;
  }
  const text = unit === 0 ? String(value) : value.toFixed(1);
  return `${text} ${SIZE_UNITS[unit]}`;
};

/** The stored UTC time as `2026-02-02 12:00 UTC`, the same on the server and in the browser. */
export const formatMtime = (iso: string): string =>
  `${iso.slice(0, 16).replace("T", " ")} UTC`;

/** True when a tRPC call failed because the file changed since it was read. */
export const isConflict = (error: unknown): boolean =>
  error instanceof TRPCClientError && error.data?.code === "CONFLICT";

/** The URL that downloads a file through the cookie session. */
export const downloadUrl = (path: string): string =>
  `/api/library/download?path=${encodeURIComponent(path)}`;

export interface DiffLine {
  kind: "add" | "del" | "same";
  text: string;
}

/** `a\nb\n` is two lines and the empty string is none. */
const splitLines = (text: string): string[] => {
  if (text === "") {
    return [];
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
};

/**
 * The most cells the LCS table may hold, 16 MB of Uint32. Above it the
 * middle is listed as deletes, then adds, instead of compared.
 */
export const MAX_DIFF_CELLS = 4_000_000;

/**
 * Diffs two runs of lines with no common prefix or suffix left to trim.
 * Changed lines are emitted as deletes, then adds, between two same lines.
 */
const diffMiddle = (a: string[], b: string[]): DiffLine[] => {
  const n = a.length;
  const m = b.length;
  if ((n + 1) * (m + 1) > MAX_DIFF_CELLS) {
    return [
      ...a.map((text): DiffLine => ({ kind: "del", text })),
      ...b.map((text): DiffLine => ({ kind: "add", text })),
    ];
  }
  const out: DiffLine[] = [];
  const width = m + 1;

  // lcs[i * width + j] is the longest common subsequence of a from i on
  // and of b from j on.
  const lcs = new Uint32Array((n + 1) * width);
  const cell = (row: number, col: number): number =>
    lcs[row * width + col] ?? 0;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? cell(i + 1, j + 1) + 1
          : Math.max(cell(i + 1, j), cell(i, j + 1));
    }
  }

  let dels: string[] = [];
  let adds: string[] = [];
  const flush = () => {
    for (const text of dels) {
      out.push({ kind: "del", text });
    }
    for (const text of adds) {
      out.push({ kind: "add", text });
    }
    dels = [];
    adds = [];
  };

  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    const left = a[i];
    const right = b[j];
    if (left !== undefined && right !== undefined && left === right) {
      flush();
      out.push({ kind: "same", text: left });
      i += 1;
      j += 1;
    } else if (
      left !== undefined &&
      (right === undefined || cell(i + 1, j) >= cell(i, j + 1))
    ) {
      dels.push(left);
      i += 1;
    } else if (right !== undefined) {
      adds.push(right);
      j += 1;
    }
  }
  flush();
  return out;
};

/**
 * A line diff of `before` to `after`. Within a block of changed lines the
 * deleted lines come before the added ones. Texts whose changed middle is
 * too large to compare (`MAX_DIFF_CELLS`) list every middle line as changed.
 */
export const lineDiff = (before: string, after: string): DiffLine[] => {
  const a = splitLines(before);
  const b = splitLines(after);

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) {
    head += 1;
  }
  let aEnd = a.length;
  let bEnd = b.length;
  while (aEnd > head && bEnd > head && a[aEnd - 1] === b[bEnd - 1]) {
    aEnd -= 1;
    bEnd -= 1;
  }

  const same = (text: string): DiffLine => ({ kind: "same", text });
  return [
    ...a.slice(0, head).map(same),
    ...diffMiddle(a.slice(head, aEnd), b.slice(head, bEnd)),
    ...a.slice(aEnd).map(same),
  ];
};

/** Where `path` lands after `from` moves to `to`. A path outside `from` is unchanged. */
export const remapPath = (path: string, from: string, to: string): string => {
  if (path === from) {
    return to;
  }
  return path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path;
};
