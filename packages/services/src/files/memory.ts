import type { FileBlobs } from "../files.ts";

export interface MemoryObject {
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
}

export type MemoryFileBlobs = FileBlobs & {
  objects: Map<string, MemoryObject>;
};

/** An in-memory `FileBlobs` for tests. `objects` shows what was stored. */
export const memoryFileBlobs = (): MemoryFileBlobs => {
  const objects = new Map<string, MemoryObject>();
  return {
    delete: (key) => {
      objects.delete(key);
      return Promise.resolve();
    },
    get: (key) => {
      const object = objects.get(key);
      return Promise.resolve(object ? new Blob([object.bytes]).stream() : null);
    },
    objects,
    put: async (key, body, contentType) => {
      objects.set(key, {
        bytes: new Uint8Array(await body.arrayBuffer()),
        contentType,
      });
    },
  };
};
