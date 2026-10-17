export interface TreeRow {
  depth: number;
  kind: "dir" | "file";
  name: string;
  path: string;
}

interface DirNode {
  dirs: Map<string, DirNode>;
  files: string[];
}

function newNode(): DirNode {
  return { dirs: new Map(), files: [] };
}

function insert(root: DirNode, path: string): void {
  const parts = path.split("/");
  const fileName = parts.pop() ?? "";
  let node = root;
  for (const part of parts) {
    let child = node.dirs.get(part);
    if (!child) {
      child = newNode();
      node.dirs.set(part, child);
    }
    node = child;
  }
  node.files.push(fileName);
}

function sortedKeys(names: Iterable<string>): string[] {
  return [...names].sort((a, b) => {
    if (a === b) {
      return 0;
    }
    return a < b ? -1 : 1;
  });
}

function emit(
  node: DirNode,
  prefix: string,
  depth: number,
  out: TreeRow[]
): void {
  for (const name of sortedKeys(node.dirs.keys())) {
    const path = prefix === "" ? name : `${prefix}/${name}`;
    out.push({ depth, kind: "dir", name, path });
    const child = node.dirs.get(name);
    if (child) {
      emit(child, path, depth + 1, out);
    }
  }
  for (const name of sortedKeys(new Set(node.files))) {
    const path = prefix === "" ? name : `${prefix}/${name}`;
    out.push({ depth, kind: "file", name, path });
  }
}

export function treeRows(paths: readonly string[]): TreeRow[] {
  const root = newNode();
  for (const path of paths) {
    insert(root, path);
  }
  const rows: TreeRow[] = [];
  emit(root, "", 0, rows);
  return rows;
}

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Client-side hint for a new file path inside a skill. The server checks
 * again. Returns an error message, or null when the trimmed input is
 * acceptable. Callers should use the trimmed value.
 */
export function validNewFilePath(input: string): string | null {
  const path = input.trim();
  if (path === "") {
    return "Enter a file path.";
  }
  if (path.startsWith("/") || path.startsWith("\\")) {
    return "The path must be relative to the skill.";
  }
  if (path.includes("\\")) {
    return "Use / as the separator, not \\.";
  }
  if (hasControlCharacter(path)) {
    return "The path cannot contain control characters.";
  }
  if (path.endsWith("/")) {
    return "The path must name a file, not a folder.";
  }
  for (const segment of path.split("/")) {
    if (segment === "") {
      return "The path cannot contain empty segments.";
    }
    if (segment === "." || segment === "..") {
      return "The path cannot contain . or .. segments.";
    }
  }
  return null;
}

export function uploadPath(dir: string, fileName: string): string {
  return dir === "" ? fileName : `${dir}/${fileName}`;
}
