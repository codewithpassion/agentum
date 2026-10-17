/**
 * Text checks and git-style unified diffs for skill files. Pure functions, no I/O.
 */

const CONTEXT_LINES = 3;
const MAX_EDITS = 2000;
const MAX_MIDDLE_LINES = 20_000;
const NO_NEWLINE_MARK = "\\ No newline at end of file";
const UTF8 = new TextDecoder("utf-8", { fatal: true });

interface Line {
  eol: boolean;
  text: string;
}

type Op =
  | { kind: "equal"; a: number; b: number }
  | { kind: "delete"; a: number }
  | { kind: "insert"; b: number };

/** True when the bytes are valid UTF-8 and hold no NUL byte. Empty input is text. */
export function isTextBytes(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) {
    return false;
  }
  try {
    UTF8.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Git-style unified diff of one file. A null side is an added or removed file. Returns "" when the texts are equal. */
export function unifiedDiff(
  path: string,
  before: string | null,
  after: string | null
): string {
  if (before === after) {
    return "";
  }
  const beforeLines = splitLines(before ?? "");
  const afterLines = splitLines(after ?? "");
  const ops = editScript(...internLines(beforeLines, afterLines));

  const { oldBefore, newBefore } = countsBefore(ops);
  const out = [
    `--- ${before === null ? "/dev/null" : `a/${path}`}`,
    `+++ ${after === null ? "/dev/null" : `b/${path}`}`,
  ];
  for (const [start, end] of hunkRanges(ops)) {
    const oldStart = oldBefore[start] ?? 0;
    const newStart = newBefore[start] ?? 0;
    const oldCount = (oldBefore[end + 1] ?? 0) - oldStart;
    const newCount = (newBefore[end + 1] ?? 0) - newStart;
    out.push(
      `@@ -${oldCount === 0 ? oldStart : oldStart + 1},${oldCount} +${newCount === 0 ? newStart : newStart + 1},${newCount} @@`
    );
    for (const op of ops.slice(start, end + 1)) {
      out.push(...renderOp(op, beforeLines, afterLines));
    }
  }
  return out.map((line) => `${line}\n`).join("");
}

/** Splits text on "\n". A trailing newline ends the last line and adds no empty line. */
function splitLines(text: string): Line[] {
  if (text === "") {
    return [];
  }
  const endsWithNewline = text.endsWith("\n");
  const parts = text.split("\n");
  if (endsWithNewline) {
    parts.pop();
  }
  return parts.map((part, index) => ({
    eol: endsWithNewline || index < parts.length - 1,
    text: part,
  }));
}

/**
 * Maps each line to an integer id. A line without a newline differs from the
 * same text with one, so git reports a change when only the newline differs.
 */
function internLines(before: Line[], after: Line[]): [number[], number[]] {
  const ids = new Map<string, number>();
  const idOf = (line: Line): number => {
    const token = `${line.eol ? "T" : "U"}${line.text}`;
    const known = ids.get(token);
    if (known !== undefined) {
      return known;
    }
    const id = ids.size;
    ids.set(token, id);
    return id;
  };
  return [before.map(idOf), after.map(idOf)];
}

/** Edit script over the whole file: common prefix and suffix, then Myers on the middle. */
function editScript(a: number[], b: number[]): Op[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) {
    head += 1;
  }
  let tailA = a.length;
  let tailB = b.length;
  while (tailA > head && tailB > head && a[tailA - 1] === b[tailB - 1]) {
    tailA -= 1;
    tailB -= 1;
  }

  const middleA = a.slice(head, tailA);
  const middleB = b.slice(head, tailB);
  const tooLarge =
    middleA.length > MAX_MIDDLE_LINES || middleB.length > MAX_MIDDLE_LINES;
  const middle =
    (tooLarge ? null : myers(middleA, middleB)) ??
    replaceAll(middleA.length, middleB.length);

  const ops: Op[] = [];
  for (let i = 0; i < head; i += 1) {
    ops.push({ a: i, b: i, kind: "equal" });
  }
  for (const op of middle) {
    ops.push(offsetOp(op, head));
  }
  for (let i = tailA; i < a.length; i += 1) {
    ops.push({ a: i, b: i - tailA + tailB, kind: "equal" });
  }
  return ops;
}

/** Myers O(ND) diff of two id arrays. Returns null when more than MAX_EDITS edits are needed. */
function myers(a: number[], b: number[]): Op[] | null {
  const pass = forwardPass(a, b);
  if (!pass) {
    return null;
  }
  return backtrack(pass.trace, pass.found, a.length, b.length);
}

/** Forward pass. Keeps one snapshot of the furthest-reaching row per edit count d. */
function forwardPass(
  a: number[],
  b: number[]
): { found: number; trace: Int32Array[] } | null {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(n + m, MAX_EDITS);
  const off = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= limit; d += 1) {
    let finished = false;
    for (let k = -d; k <= d && !finished; k += 2) {
      const down =
        k === -d ||
        (k !== d && valueAt(v, off + k - 1) < valueAt(v, off + k + 1));
      let x = down ? valueAt(v, off + k + 1) : valueAt(v, off + k - 1) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[off + k] = x;
      finished = x >= n && y >= m;
    }
    trace.push(v.slice(off - d, off + d + 1));
    if (finished) {
      return { found: d, trace };
    }
  }
  return null;
}

/** Walks the snapshots back from (n, m) and returns the edit script in order. */
function backtrack(
  trace: Int32Array[],
  found: number,
  n: number,
  m: number
): Op[] {
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d -= 1) {
    const prev = trace[d - 1] ?? new Int32Array();
    const shift = d - 1;
    const k = x - y;
    const down =
      k === -d ||
      (k !== d && valueAt(prev, k - 1 + shift) < valueAt(prev, k + 1 + shift));
    const prevK = down ? k + 1 : k - 1;
    const prevX = valueAt(prev, prevK + shift);
    const midX = down ? prevX : prevX + 1;
    while (x > midX) {
      x -= 1;
      y -= 1;
      ops.push({ a: x, b: y, kind: "equal" });
    }
    if (down) {
      y -= 1;
      ops.push({ b: y, kind: "insert" });
    } else {
      x -= 1;
      ops.push({ a: x, kind: "delete" });
    }
  }
  while (x > 0) {
    x -= 1;
    y -= 1;
    ops.push({ a: x, b: y, kind: "equal" });
  }
  return ops.reverse();
}

function valueAt(values: ArrayLike<number>, index: number): number {
  return values[index] ?? 0;
}

/** One block: every line of the middle removed, then every line added. */
function replaceAll(removed: number, added: number): Op[] {
  const ops: Op[] = [];
  for (let i = 0; i < removed; i += 1) {
    ops.push({ a: i, kind: "delete" });
  }
  for (let i = 0; i < added; i += 1) {
    ops.push({ b: i, kind: "insert" });
  }
  return ops;
}

function offsetOp(op: Op, head: number): Op {
  if (op.kind === "equal") {
    return { a: op.a + head, b: op.b + head, kind: "equal" };
  }
  if (op.kind === "delete") {
    return { a: op.a + head, kind: "delete" };
  }
  return { b: op.b + head, kind: "insert" };
}

/** Running count of before-side and after-side lines ahead of each op, plus the total at the end. */
function countsBefore(ops: Op[]): {
  oldBefore: number[];
  newBefore: number[];
} {
  const oldBefore: number[] = [];
  const newBefore: number[] = [];
  let oldSeen = 0;
  let newSeen = 0;
  for (const op of ops) {
    oldBefore.push(oldSeen);
    newBefore.push(newSeen);
    if (op.kind !== "insert") {
      oldSeen += 1;
    }
    if (op.kind !== "delete") {
      newSeen += 1;
    }
  }
  oldBefore.push(oldSeen);
  newBefore.push(newSeen);
  return { newBefore, oldBefore };
}

/** Inclusive op index ranges of the hunks. Changes whose context touches or overlaps share a hunk. */
function hunkRanges(ops: Op[]): [number, number][] {
  const ranges: [number, number][] = [];
  ops.forEach((op, index) => {
    if (op.kind === "equal") {
      return;
    }
    const start = Math.max(0, index - CONTEXT_LINES);
    const end = Math.min(ops.length - 1, index + CONTEXT_LINES);
    const last = ranges.at(-1);
    if (last && start <= last[1] + 1) {
      last[1] = end;
    } else {
      ranges.push([start, end]);
    }
  });
  return ranges;
}

function renderOp(op: Op, before: Line[], after: Line[]): string[] {
  if (op.kind === "insert") {
    return lineWithMarker("+", after, op.b);
  }
  if (op.kind === "delete") {
    return lineWithMarker("-", before, op.a);
  }
  return lineWithMarker(" ", before, op.a);
}

function lineWithMarker(
  prefix: string,
  lines: Line[],
  index: number
): string[] {
  const line = lines[index];
  if (!line) {
    return [];
  }
  const text = `${prefix}${line.text}`;
  return line.eol ? [text] : [text, NO_NEWLINE_MARK];
}
