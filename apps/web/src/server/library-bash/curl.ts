/**
 * The `curl` command for the library shell. just-bash has no usable curl on a
 * Worker, so this maps the flags an agent uses onto a WebFetchRequest and maps
 * the fetcher's answer back to stdout, stderr and an exit code. Address checks,
 * redirects, the size cap, the timeout and logging all live in the fetcher.
 */
import {
  type Command,
  defineCommand,
  type ExecResult,
  type ResolvedCommandContext,
} from "just-bash/browser";
import {
  NETWORK_OFF_MESSAGE,
  type WebFetcher,
  type WebFetchFailure,
  type WebFetchRequest,
  type WebFetchResult,
} from "../web-fetch/types.ts";

type Answer = Extract<WebFetchResult, { ok: true }>;

/** Exit codes from curl(1). */
const EXIT_USAGE = 2;
const EXIT_WRITE_FAILED = 23;
const EXIT_READ_FAILED = 26;
const EXIT_HTTP_ERROR = 22;

const FAILURE_EXIT: Record<WebFetchFailure, number> = {
  bad_request: 2,
  blocked: 7,
  timeout: 28,
  too_large: 63,
  too_many_redirects: 47,
  unreachable: 7,
};

const encoder = new TextEncoder();
const AMPERSAND = encoder.encode("&");
const NOTHING = new Uint8Array(0);

/** Chunk size for String.fromCharCode, so a large body does not overflow the argument list. */
const LATIN1_CHUNK = 8192;

/** Every flag the command knows, by its short and long names. */
const OPTION_NAMES: Record<string, string> = {
  "--compressed": "compressed",
  "--data": "data",
  "--data-binary": "data",
  "--data-raw": "data",
  "--fail": "fail",
  "--head": "head",
  "--header": "header",
  "--include": "include",
  "--location": "location",
  "--output": "output",
  "--request": "request",
  "--show-error": "show-error",
  "--silent": "silent",
  "--user": "user",
  "--user-agent": "user-agent",
  "-A": "user-agent",
  "-d": "data",
  "-f": "fail",
  "-H": "header",
  "-I": "head",
  "-i": "include",
  "-L": "location",
  "-o": "output",
  "-S": "show-error",
  "-s": "silent",
  "-u": "user",
  "-X": "request",
};

/** Options that take a value. Every other option is a switch. */
const VALUE_OPTIONS = new Set([
  "data",
  "header",
  "output",
  "request",
  "user",
  "user-agent",
]);

/** A failure the agent should see. The exit code is curl's. */
class CurlError extends Error {
  readonly exitCode: number;

  constructor(exitCode: number, text: string) {
    super(text);
    this.exitCode = exitCode;
  }
}

interface ParsedArgs {
  data: string[];
  failOnHttpError: boolean;
  head: boolean;
  headers: [string, string][];
  include: boolean;
  method?: string;
  output?: string;
  url: string | undefined;
  userPass?: string;
}

const parseHeader = (line: string): [string, string] => {
  const colon = line.indexOf(":");
  const name = colon === -1 ? "" : line.slice(0, colon).trim();
  if (name === "") {
    // The header line can hold a secret, so it is not echoed here.
    throw new CurlError(EXIT_USAGE, "header must be in the form Name: value");
  }
  return [name, line.slice(colon + 1).trim()];
};

const applyValue = (options: ParsedArgs, key: string, value: string) => {
  switch (key) {
    case "data":
      options.data.push(value);
      break;
    case "header":
      options.headers.push(parseHeader(value));
      break;
    case "user-agent":
      options.headers.push(["User-Agent", value]);
      break;
    case "output":
      options.output = value;
      break;
    case "request":
      options.method = value;
      break;
    case "user":
      options.userPass = value;
      break;
    default:
      break;
  }
};

const applySwitch = (options: ParsedArgs, key: string) => {
  switch (key) {
    case "fail":
      options.failOnHttpError = true;
      break;
    case "head":
      options.head = true;
      break;
    case "include":
      options.include = true;
      break;
    // -s, -S, -L and --compressed change nothing: progress is never printed,
    // errors always are, and the fetcher always follows redirects.
    default:
      break;
  }
};

const unsupported = (name: string) =>
  new CurlError(EXIT_USAGE, `option ${name} is not supported`);

/** Handles `--name`, `--name=value` and `--name value`. */
const parseLong = (
  options: ParsedArgs,
  arg: string,
  nextArg: (name: string) => string
) => {
  const equals = arg.indexOf("=");
  const name = equals === -1 ? arg : arg.slice(0, equals);
  const key = OPTION_NAMES[name];
  if (key === undefined) {
    throw unsupported(name);
  }
  if (!VALUE_OPTIONS.has(key)) {
    if (equals !== -1) {
      throw new CurlError(EXIT_USAGE, `option ${name} takes no value`);
    }
    applySwitch(options, key);
    return;
  }
  applyValue(
    options,
    key,
    equals === -1 ? nextArg(name) : arg.slice(equals + 1)
  );
};

/** Handles a cluster such as `-sSL`, or `-XPOST` where a value shares the argument. */
const parseShortCluster = (
  options: ParsedArgs,
  arg: string,
  nextArg: (name: string) => string
) => {
  for (let j = 1; j < arg.length; j += 1) {
    const name = `-${arg[j]}`;
    const key = OPTION_NAMES[name];
    if (key === undefined) {
      throw unsupported(name);
    }
    if (VALUE_OPTIONS.has(key)) {
      // The rest of the cluster is the value, or else the next argument is.
      const rest = arg.slice(j + 1);
      applyValue(options, key, rest === "" ? nextArg(name) : rest);
      return;
    }
    applySwitch(options, key);
  }
};

const parseArgs = (args: string[]): ParsedArgs => {
  const options: ParsedArgs = {
    data: [],
    failOnHttpError: false,
    head: false,
    headers: [],
    include: false,
    url: undefined,
  };

  let i = 0;
  const nextArg = (name: string): string => {
    if (i >= args.length) {
      throw new CurlError(EXIT_USAGE, `option ${name} requires a value`);
    }
    const value = args[i] ?? "";
    i += 1;
    return value;
  };

  while (i < args.length) {
    const arg = args[i] ?? "";
    i += 1;
    if (arg.startsWith("--")) {
      parseLong(options, arg, nextArg);
    } else if (arg.startsWith("-") && arg.length > 1) {
      parseShortCluster(options, arg, nextArg);
    } else if (options.url === undefined) {
      options.url = arg;
    } else {
      throw new CurlError(EXIT_USAGE, "only one URL is supported");
    }
  }

  return options;
};

/** Joins byte parts with `separator` between them. */
const joinBytes = (parts: Uint8Array[], separator: Uint8Array): Uint8Array => {
  const size =
    parts.reduce((total, part) => total + part.byteLength, 0) +
    separator.byteLength * Math.max(0, parts.length - 1);
  const out = new Uint8Array(size);
  let offset = 0;
  parts.forEach((part, index) => {
    if (index > 0) {
      out.set(separator, offset);
      offset += separator.byteLength;
    }
    out.set(part, offset);
    offset += part.byteLength;
  });
  return out;
};

/**
 * just-bash carries a byte buffer as a string with one char per byte, which is
 * the form `bytesOutput` uses. The browser entry does not export that helper,
 * so the conversion is spelled out here.
 */
const byteString = (bytes: Uint8Array): string => {
  let text = "";
  for (let i = 0; i < bytes.length; i += LATIN1_CHUNK) {
    text += String.fromCharCode(...bytes.subarray(i, i + LATIN1_CHUNK));
  }
  return text;
};

const stdinBytes = (stdin: ResolvedCommandContext["stdin"]): Uint8Array => {
  // The same one-char-per-byte string as byteString, read back the other way.
  const text = stdin as unknown as string;
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
};

const readDataPart = async (
  part: string,
  ctx: ResolvedCommandContext
): Promise<Uint8Array> => {
  if (!part.startsWith("@")) {
    return encoder.encode(part);
  }
  const source = part.slice(1);
  if (source === "-") {
    return stdinBytes(ctx.stdin);
  }
  const bytes = await ctx.fs
    .readFileBuffer(ctx.fs.resolvePath(ctx.cwd, source))
    .catch(() => undefined);
  if (bytes === undefined) {
    throw new CurlError(EXIT_READ_FAILED, `(26) could not read ${source}`);
  }
  return bytes;
};

const readBody = async (
  parts: string[],
  ctx: ResolvedCommandContext
): Promise<Uint8Array> => {
  const pieces = await Promise.all(
    parts.map((part) => readDataPart(part, ctx))
  );
  return joinBytes(pieces, AMPERSAND);
};

const basicCredentials = (userPass: string): string => {
  // curl asks for a password when none is given. A script cannot answer, so
  // the password is left empty.
  const credentials = userPass.includes(":") ? userPass : `${userPass}:`;
  return btoa(byteString(encoder.encode(credentials)));
};

const buildHeaders = (
  options: ParsedArgs,
  hasBody: boolean
): Record<string, string> => {
  // Keyed by the lower-case name, so a later header replaces an earlier one
  // whatever its casing.
  const headers = new Map<string, [string, string]>();
  const set = (name: string, value: string) => {
    headers.set(name.toLowerCase(), [name, value]);
  };
  for (const [name, value] of options.headers) {
    set(name, value);
  }
  if (options.userPass !== undefined) {
    set("Authorization", `Basic ${basicCredentials(options.userPass)}`);
  }
  if (hasBody && !headers.has("content-type")) {
    set("Content-Type", "application/x-www-form-urlencoded");
  }
  return Object.fromEntries(headers.values());
};

const statusAndHeaders = (answer: Answer): Uint8Array => {
  const lines = [
    `HTTP/1.1 ${answer.status} ${answer.statusText}`,
    ...Object.entries(answer.headers).map(
      ([name, value]) => `${name}: ${value}`
    ),
  ];
  return encoder.encode(`${lines.join("\r\n")}\r\n\r\n`);
};

const defaultMethod = (head: boolean, hasBody: boolean): string => {
  if (head) {
    return "HEAD";
  }
  return hasBody ? "POST" : "GET";
};

const run = async (
  web: WebFetcher,
  args: string[],
  ctx: ResolvedCommandContext
): Promise<ExecResult> => {
  const options = parseArgs(args);
  if (options.url === undefined) {
    throw new CurlError(EXIT_USAGE, "no URL specified");
  }
  const body =
    options.data.length > 0 ? await readBody(options.data, ctx) : undefined;
  const method =
    options.method ?? defaultMethod(options.head, body !== undefined);

  const request: WebFetchRequest = {
    headers: buildHeaders(options, body !== undefined),
    method,
    url: options.url,
    ...(body === undefined ? {} : { body }),
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  };
  const result = await web(request);
  if (!result.ok) {
    const exitCode = FAILURE_EXIT[result.error];
    throw new CurlError(exitCode, `(${exitCode}) ${result.message}`);
  }
  if (options.failOnHttpError && result.status >= 400) {
    throw new CurlError(
      EXIT_HTTP_ERROR,
      `(${EXIT_HTTP_ERROR}) The requested URL returned error: ${result.status}`
    );
  }

  // curl -I prints the headers and no body. A HEAD answer has no body anyway.
  const bodyBytes = options.head ? NOTHING : result.bytes;
  if (options.output === undefined) {
    const parts: Uint8Array[] = [];
    if (options.include || options.head) {
      parts.push(statusAndHeaders(result));
    }
    parts.push(bodyBytes);
    return stdoutBytes(joinBytes(parts, NOTHING));
  }

  const written = await ctx.fs
    .writeFile(ctx.fs.resolvePath(ctx.cwd, options.output), bodyBytes)
    .then(
      () => true,
      () => false
    );
  if (!written) {
    throw new CurlError(
      EXIT_WRITE_FAILED,
      `(${EXIT_WRITE_FAILED}) could not write ${options.output}`
    );
  }
  const header =
    options.include || options.head ? statusAndHeaders(result) : NOTHING;
  return stdoutBytes(header);
};

const stdoutBytes = (bytes: Uint8Array): ExecResult => ({
  exitCode: 0,
  stderr: "",
  stdout: byteString(bytes),
  stdoutKind: "bytes",
});

/**
 * `curl` for the library shell. With no network it says so and exits 1
 * without reading its arguments. `onRun` is called each time the command
 * starts, before anything is read or sent, so the caller knows a script used
 * the network even when curl then refused it.
 */
export const curlCommand = (
  web: WebFetcher | undefined,
  onRun?: () => void
): Command =>
  defineCommand("curl", async (args, ctx) => {
    onRun?.();
    if (web === undefined) {
      return {
        exitCode: 1,
        stderr: `curl: ${NETWORK_OFF_MESSAGE}\n`,
        stdout: "",
      };
    }
    try {
      return await run(web, args, ctx);
    } catch (error) {
      if (error instanceof CurlError) {
        return {
          exitCode: error.exitCode,
          stderr: `curl: ${error.message}\n`,
          stdout: "",
        };
      }
      throw error;
    }
  });
