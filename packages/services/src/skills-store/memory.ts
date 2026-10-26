import type { SkillBlobs } from "../skills-store.ts";

export type MemorySkillBlobs = SkillBlobs & {
  /** Every key `put` was called with, in order. */
  puts: string[];
  objects: Map<string, Uint8Array>;
};

/** An in-memory `SkillBlobs` for tests. `objects` shows what was stored and `puts` how often. */
export const memorySkillBlobs = (): MemorySkillBlobs => {
  const objects = new Map<string, Uint8Array>();
  const puts: string[] = [];
  return {
    exists: (key) => Promise.resolve(objects.has(key)),
    get: (key) => {
      const object = objects.get(key);
      return Promise.resolve(object ? object.slice() : null);
    },
    objects,
    put: (key, bytes) => {
      puts.push(key);
      objects.set(key, bytes.slice());
      return Promise.resolve();
    },
    puts,
    remove: (key) => {
      objects.delete(key);
      return Promise.resolve();
    },
  };
};
