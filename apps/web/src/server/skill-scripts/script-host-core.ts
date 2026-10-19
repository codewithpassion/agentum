import type { LibraryOps } from "../library-bash/library-fs.ts";
import type { WebFetcher } from "../web-fetch/types.ts";
import { NETWORK_OFF_MESSAGE } from "../web-fetch/types.ts";
import { libraryPathOf } from "./library-path.ts";
import type {
  HostFetchRequest,
  HostFetchResult,
  ScriptHostApi,
} from "./script-host-api.ts";

export interface ScriptHostDeps {
  fetcher: WebFetcher | undefined;
  home: string;
  ops: Pick<LibraryOps, "list" | "read" | "write">;
}

const FAILED_MESSAGE = "The request failed.";

const lastSegment = (path: string): string =>
  path.slice(path.lastIndexOf("/") + 1);

/** The script holds the stub itself and can call it with anything, so every argument is checked here. */
const textArg = (value: unknown, name: string): string => {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string`);
  }
  return value;
};

const bytesArg = (value: unknown): Uint8Array => {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError("bytes must be a Uint8Array");
  }
  return value;
};

/** The `HOST` API over a library and an optional fetcher. Pure: the caller binds the ops and the fetcher. */
export const createScriptHost = ({
  fetcher,
  home,
  ops,
}: ScriptHostDeps): ScriptHostApi => {
  const send = async (request: HostFetchRequest): Promise<HostFetchResult> => {
    if (fetcher === undefined) {
      return { message: NETWORK_OFF_MESSAGE, ok: false };
    }
    if (request.body !== undefined && !(request.body instanceof Uint8Array)) {
      return { message: "The request body must be bytes.", ok: false };
    }
    let result: Awaited<ReturnType<WebFetcher>>;
    try {
      result = await fetcher({
        ...(request.body === undefined ? {} : { body: request.body }),
        headers: Object.fromEntries(request.headers),
        method: request.method,
        url: request.url,
      });
    } catch {
      return { message: FAILED_MESSAGE, ok: false };
    }
    if (!result.ok) {
      return { message: result.message, ok: false };
    }
    return {
      body: result.bytes,
      headers: Object.entries(result.headers),
      ok: true,
      status: result.status,
      statusText: result.statusText,
    };
  };

  return {
    list: async (dir) =>
      (await ops.list(libraryPathOf(home, textArg(dir, "dir")))).map(
        (entry) => ({
          kind: entry.kind,
          name: lastSegment(entry.path),
        })
      ),
    read: async (path) =>
      (await ops.read(libraryPathOf(home, textArg(path, "path")))).bytes,
    send,
    write: async (path, bytes) => {
      await ops.write(
        libraryPathOf(home, textArg(path, "path")),
        bytesArg(bytes)
      );
    },
  };
};
