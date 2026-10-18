// In-memory ports for the tests of this module and of the adapters built on it.
import type {
  LocalPort,
  ManifestEntry,
  ManifestStore,
  RemoteEntry,
  RemotePort,
} from "./types.ts";

const ENCODER = new TextEncoder();

export const bytesOf = (text: string): Uint8Array => ENCODER.encode(text);
export const textOf = (bytes: Uint8Array | undefined): string | undefined =>
  bytes === undefined ? undefined : new TextDecoder().decode(bytes);

export interface MemoryRemote extends RemotePort {
  /** Every call, in order, as `name path`. */
  calls: string[];
  /** Paths whose next `write` throws, once. */
  failWrites: Set<string>;
  /** Files by library path. The etag changes with every write. */
  files: Map<string, { bytes: Uint8Array; etag: string }>;
  /** Puts a file in as another writer would: new bytes, new etag. */
  put: (path: string, text: string) => string;
}

export const createMemoryRemote = (): MemoryRemote => {
  const files = new Map<string, { bytes: Uint8Array; etag: string }>();
  const calls: string[] = [];
  const failWrites = new Set<string>();
  let version = 0;
  const put = (path: string, text: string): string => {
    version += 1;
    const etag = `e${version}`;
    files.set(path, { bytes: bytesOf(text), etag });
    return etag;
  };
  const entryOf = (path: string): RemoteEntry | null => {
    const file = files.get(path);
    if (file) {
      return {
        etag: file.etag,
        kind: "file",
        path,
        size: file.bytes.byteLength,
      };
    }
    const isDir = [...files.keys()].some((key) => key.startsWith(`${path}/`));
    return isDir ? { etag: null, kind: "dir", path, size: 0 } : null;
  };
  return {
    calls,
    delete: (path) => {
      calls.push(`delete ${path}`);
      files.delete(path);
      return Promise.resolve();
    },
    failWrites,
    files,
    list: (dir) => {
      calls.push(`list ${dir}`);
      const children = new Map<string, RemoteEntry>();
      for (const key of files.keys()) {
        if (!key.startsWith(dir === "" ? "" : `${dir}/`)) {
          continue;
        }
        const rest = dir === "" ? key : key.slice(dir.length + 1);
        const name = rest.split("/")[0] ?? rest;
        const path = dir === "" ? name : `${dir}/${name}`;
        const entry = entryOf(path);
        if (entry) {
          children.set(path, entry);
        }
      }
      return Promise.resolve([...children.values()]);
    },
    put,
    read: (path) => {
      calls.push(`read ${path}`);
      const file = files.get(path);
      return Promise.resolve(
        file ? { bytes: file.bytes, etag: file.etag } : null
      );
    },
    stat: (path) => {
      calls.push(`stat ${path}`);
      return Promise.resolve(entryOf(path));
    },
    write: (path, bytes, options) => {
      calls.push(`write ${path}`);
      if (failWrites.delete(path)) {
        return Promise.reject(new Error(`write ${path} failed`));
      }
      const current = files.get(path);
      if (options?.ifEtag !== undefined && current?.etag !== options.ifEtag) {
        return Promise.resolve(null);
      }
      version += 1;
      const etag = `e${version}`;
      files.set(path, { bytes, etag });
      return Promise.resolve({ etag });
    },
  };
};

export interface MemoryLocal extends LocalPort {
  /** Paths whose next `write` throws, once. */
  failWrites: Set<string>;
  files: Map<string, Uint8Array>;
  /** Puts a file in as the agent would. */
  put: (path: string, text: string) => void;
}

export const createMemoryLocal = (): MemoryLocal => {
  const files = new Map<string, Uint8Array>();
  const failWrites = new Set<string>();
  const isDir = (path: string) =>
    [...files.keys()].some((key) => key.startsWith(`${path}/`));
  return {
    failWrites,
    files,
    list: (dir) => {
      const children = new Map<string, "dir" | "file">();
      for (const key of files.keys()) {
        if (!key.startsWith(`${dir}/`)) {
          continue;
        }
        const rest = key.slice(dir.length + 1);
        const [name = rest] = rest.split("/");
        children.set(name, rest.includes("/") ? "dir" : "file");
      }
      return Promise.resolve(
        [...children].map(([name, kind]) => ({ kind, name }))
      );
    },
    put: (path, text) => {
      files.set(path, bytesOf(text));
    },
    read: (path) => {
      const bytes = files.get(path);
      return bytes
        ? Promise.resolve(bytes)
        : Promise.reject(new Error(`no such file: ${path}`));
    },
    remove: (path) => {
      files.delete(path);
      return Promise.resolve();
    },
    stat: (path) => {
      const bytes = files.get(path);
      if (bytes) {
        return Promise.resolve({ kind: "file", size: bytes.byteLength });
      }
      return Promise.resolve(isDir(path) ? { kind: "dir", size: 0 } : null);
    },
    write: (path, bytes) => {
      if (failWrites.delete(path)) {
        return Promise.reject(new Error(`write ${path} failed`));
      }
      files.set(path, bytes);
      return Promise.resolve();
    },
  };
};

export interface MemoryManifest extends ManifestStore {
  saved: ManifestEntry[];
}

export const createMemoryManifest = (): MemoryManifest => {
  const store: MemoryManifest = {
    load: () => Promise.resolve(store.saved.map((entry) => ({ ...entry }))),
    save: (entries) => {
      store.saved = entries.map((entry) => ({ ...entry }));
      return Promise.resolve();
    },
    saved: [],
  };
  return store;
};
