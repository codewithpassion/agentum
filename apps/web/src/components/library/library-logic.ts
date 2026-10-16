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

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The URL that downloads a file through the cookie session. */
export const downloadUrl = (path: string): string =>
  `/api/library/download?path=${encodeURIComponent(path)}`;
