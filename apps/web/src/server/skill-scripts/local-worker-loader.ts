/**
 * A stand-in for the Worker Loader under `bun test`. It writes each load's
 * modules to a temp folder and runs the entrypoint's class from there, in this
 * process. Only tests import it. The harness changes process-wide state while
 * it runs (console, process, fetch and the library globals), so `restore` puts
 * that state back and removes the temp folders.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { BundleModule } from "./script-bundle.ts";

/** The part of a Worker Loader call that the helper reads. */
interface WorkerCodeLike {
  env?: Record<string, unknown>;
  globalOutbound?: unknown;
  mainModule: string;
  modules: Record<string, BundleModule>;
}

/** What the harness reads and changes: `[holder, key]` pairs. */
const slots = (): [object, string][] => [
  [console, "log"],
  [console, "info"],
  [console, "debug"],
  [console, "warn"],
  [console, "error"],
  [process, "argv"],
  [process, "exit"],
  [process.stdout, "write"],
  [process.stderr, "write"],
  [globalThis, "fetch"],
  [globalThis, "stdin"],
  [globalThis, "library"],
];

interface Saved {
  holder: object;
  key: string;
  present: boolean;
  value: unknown;
}

const snapshot = (): Saved[] =>
  slots().map(([holder, key]) => ({
    holder,
    key,
    present: Reflect.has(holder, key),
    value: Reflect.get(holder, key),
  }));

const putBack = (saved: Saved[]): void => {
  for (const { holder, key, present, value } of saved) {
    if (present) {
      Reflect.set(holder, key, value);
    } else {
      Reflect.deleteProperty(holder, key);
    }
  }
};

/** workerd provides `cloudflare:workers` and bun does not, and the root `bun test scripts` run has no preload to mock it. A plain class stands in. */
const WORKERS_IMPORT = 'import { WorkerEntrypoint } from "cloudflare:workers";';

const writeModule = (
  folder: string,
  name: string,
  module: BundleModule
): void => {
  const path = join(folder, name);
  mkdirSync(dirname(path), { recursive: true });
  if ("js" in module) {
    writeFileSync(
      path,
      module.js.replace(WORKERS_IMPORT, "class WorkerEntrypoint {}")
    );
  } else if ("json" in module) {
    writeFileSync(path, JSON.stringify(module.json));
  } else {
    writeFileSync(path, new Uint8Array(module.data));
  }
};

type Method = (...args: unknown[]) => unknown;

interface EntrypointInstance {
  env?: Record<string, unknown>;
  [method: string]: unknown;
}

export const localWorkerLoader = (): {
  configs: WorkerCodeLike[];
  loader: WorkerLoader;
  restore: () => void;
} => {
  const configs: WorkerCodeLike[] = [];
  const folders: string[] = [];
  const saved = snapshot();
  const restore = (): void => {
    putBack(saved);
    for (const folder of folders.splice(0)) {
      rmSync(folder, { force: true, recursive: true });
    }
  };
  const loader = {
    configs,
    load: (config: WorkerCodeLike) => {
      configs.push(config);
      const folder = mkdtempSync(join(tmpdir(), "local-worker-"));
      folders.push(folder);
      for (const [name, module] of Object.entries(config.modules)) {
        writeModule(folder, name, module);
      }
      return {
        getEntrypoint: (name: string) =>
          new Proxy<Record<string, Method>>(
            {},
            {
              get: (_target, method) => {
                if (typeof method !== "string") {
                  return;
                }
                return async (...args: unknown[]) => {
                  try {
                    const url = pathToFileURL(
                      join(folder, config.mainModule)
                    ).href;
                    const module: Record<string, unknown> = await import(url);
                    const Entry = module[name] as new () => EntrypointInstance;
                    const instance = new Entry();
                    instance.env = config.env;
                    const call = instance[method];
                    if (typeof call !== "function") {
                      throw new TypeError(`${name} has no method ${method}`);
                    }
                    return await (call as Method).apply(instance, args);
                  } finally {
                    putBack(saved);
                  }
                };
              },
            }
          ),
      };
    },
  };
  return { configs, loader: loader as unknown as WorkerLoader, restore };
};
