/**
 * What the platform gives a `run_script` isolate as its `HOST` binding. The
 * isolate's harness turns it into the `library` global and a `fetch` that goes
 * through the platform's fetcher. Paths are library paths: absolute under
 * `/library`, or relative to the agent's home folder.
 */

/** A request the harness sends on for the script. Headers are name and value pairs. */
export interface HostFetchRequest {
  body?: Uint8Array;
  headers: [string, string][];
  method: string;
  url: string;
}

export type HostFetchResult =
  | {
      body: Uint8Array;
      headers: [string, string][];
      ok: true;
      status: number;
      statusText: string;
    }
  | { message: string; ok: false };

export interface HostEntry {
  kind: "dir" | "file";
  name: string;
}

export interface ScriptHostApi {
  /** The entries of a library folder. Rejects when it is missing. */
  list: (dir: string) => Promise<HostEntry[]>;
  /** The bytes of a library file. Rejects when it is missing. */
  read: (path: string) => Promise<Uint8Array>;
  /** Sends the request through the agent's fetcher (named `send` because a service stub already has a `fetch`). A refusal or failure is `ok: false` with a message, not a rejection. */
  send: (request: HostFetchRequest) => Promise<HostFetchResult>;
  /** Writes a library file, making missing folders. Rejects when the agent may not write there. */
  write: (path: string, bytes: Uint8Array) => Promise<void>;
}
