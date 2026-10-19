import { beforeEach, describe, expect, test } from "bun:test";
import { Bash } from "just-bash/browser";
import {
  NETWORK_OFF_MESSAGE,
  type WebFetcher,
  type WebFetchFailure,
  type WebFetchRequest,
  type WebFetchResult,
} from "../web-fetch/types.ts";
import { curlCommand } from "./curl.ts";

const encoder = new TextEncoder();

let calls: WebFetchRequest[];
let next: WebFetchResult;

const answer = (
  body: string | Uint8Array,
  overrides: { headers?: Record<string, string>; status?: number } = {}
): WebFetchResult => ({
  bytes: typeof body === "string" ? encoder.encode(body) : body,
  durationMs: 1,
  headers: overrides.headers ?? { "x-kind": "test" },
  ok: true,
  status: overrides.status ?? 200,
  statusText: overrides.status === 404 ? "Not Found" : "OK",
  url: "https://example.com/",
});

const fetcher: WebFetcher = (request) => {
  calls.push(request);
  return Promise.resolve(next);
};

const shell = () => new Bash({ customCommands: [curlCommand(fetcher)] });

const offlineShell = () =>
  new Bash({ customCommands: [curlCommand(undefined)] });

const decode = (bytes: Uint8Array | undefined) =>
  new TextDecoder().decode(bytes);

beforeEach(() => {
  calls = [];
  next = answer("hello\n");
});

describe("curl", () => {
  test("GET prints the body", async () => {
    const result = await shell().exec("curl -s https://example.com/a");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello\n");
    expect(result.stderr).toBe("");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("https://example.com/a");
    expect(calls[0]?.body).toBeUndefined();
  });

  test("-I sends HEAD and prints the headers only", async () => {
    next = answer("", { headers: { "x-a": "1" } });
    const result = await shell().exec("curl -sI https://example.com/a");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("HTTP/1.1 200 OK\r\nx-a: 1\r\n\r\n");
    expect(calls[0]?.method).toBe("HEAD");
  });

  test("-i prints the status line, the headers, then the body", async () => {
    next = answer("hello", { headers: { "x-a": "1" } });
    const result = await shell().exec("curl -si https://example.com/a");
    expect(result.stdout).toBe("HTTP/1.1 200 OK\r\nx-a: 1\r\n\r\nhello");
  });

  test("-X POST with headers and repeated -d joins the bodies", async () => {
    const result = await shell().exec(
      "curl -s -X POST -H 'X-Token: t1' -H 'Accept: application/json' -d a=b -d c=d https://example.com/p"
    );
    expect(result.exitCode).toBe(0);
    const [call] = calls;
    expect(call?.method).toBe("POST");
    expect(call?.headers).toEqual({
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Token": "t1",
    });
    expect(decode(call?.body)).toBe("a=b&c=d");
  });

  test("a caller's own Content-Type is kept", async () => {
    await shell().exec(
      "curl -s -H 'content-type: application/json' -d '{}' https://example.com/p"
    );
    expect(calls[0]?.headers).toEqual({ "content-type": "application/json" });
  });

  test("-d @file reads a file written earlier in the same script", async () => {
    const result = await shell().exec(
      "printf 'x=1' > body.txt && curl -s -d @body.txt https://example.com/p"
    );
    expect(result.exitCode).toBe(0);
    expect(decode(calls[0]?.body)).toBe("x=1");
  });

  test("-d @- reads the body from stdin", async () => {
    const result = await shell().exec(
      "printf 'y=2' | curl -s -d @- https://example.com/p"
    );
    expect(result.exitCode).toBe(0);
    expect(decode(calls[0]?.body)).toBe("y=2");
  });

  test("-d @file with a missing file exits 26 without a request", async () => {
    const result = await shell().exec(
      "curl -s -d @missing.txt https://example.com/p"
    );
    expect(result.exitCode).toBe(26);
    expect(result.stderr).toBe("curl: (26) could not read missing.txt\n");
    expect(calls).toHaveLength(0);
  });

  test("-o writes the body to the file and prints nothing", async () => {
    const binary = new Uint8Array([0, 1, 127, 128, 200, 255]);
    next = answer(binary);
    const script = shell();
    const result = await script.exec(
      "curl -s -o out.bin https://example.com/f"
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    const cwd = (await script.exec("pwd")).stdout.trim();
    const written = await script.fs.readFileBuffer(`${cwd}/out.bin`);
    expect(Array.from(written)).toEqual(Array.from(binary));
  });

  test("-u adds a Basic Authorization header", async () => {
    await shell().exec("curl -s -u alice:s3cret https://example.com/a");
    expect(calls[0]?.headers).toEqual({
      Authorization: `Basic ${Buffer.from("alice:s3cret").toString("base64")}`,
    });
  });

  test("-A sets the User-Agent", async () => {
    await shell().exec("curl -s -A harbour/1 https://example.com/a");
    expect(calls[0]?.headers).toEqual({ "User-Agent": "harbour/1" });
  });

  test("-f on a 404 exits 22, prints no body, and says why", async () => {
    next = answer("missing page", { status: 404 });
    const result = await shell().exec("curl -sf https://example.com/x");
    expect(result.exitCode).toBe(22);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "curl: (22) The requested URL returned error: 404\n"
    );
  });

  test("without -f a 404 body is printed and the exit is 0", async () => {
    next = answer("missing page", { status: 404 });
    const result = await shell().exec("curl -s https://example.com/x");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("missing page");
  });

  test.each([
    ["blocked", 7],
    ["unreachable", 7],
    ["timeout", 28],
    ["too_large", 63],
    ["too_many_redirects", 47],
    ["bad_request", 2],
  ] as [WebFetchFailure, number][])(
    "fetcher failure %s exits %i with its message",
    async (error, code) => {
      next = { error, message: "the fetcher said so", ok: false };
      const result = await shell().exec("curl -s https://example.com/a");
      expect(result.exitCode).toBe(code);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(`curl: (${code}) the fetcher said so\n`);
    }
  );

  test("a fetcher failure is printed even with -s", async () => {
    next = { error: "timeout", message: "took too long", ok: false };
    const result = await shell().exec("curl -s https://example.com/a");
    expect(result.stderr).toBe("curl: (28) took too long\n");
  });

  test("combined short flags like -sSL work", async () => {
    const result = await shell().exec("curl -sSL https://example.com/a");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello\n");
    expect(calls).toHaveLength(1);
  });

  test("a short option can take its value from the same argument", async () => {
    await shell().exec("curl -sXPUT https://example.com/a");
    expect(calls[0]?.method).toBe("PUT");
  });

  test("--option=value and --option value both work", async () => {
    await shell().exec(
      "curl -s --request=PATCH --header 'X-A: 1' --data=q=1 https://example.com/a"
    );
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.headers).toEqual({
      "Content-Type": "application/x-www-form-urlencoded",
      "X-A": "1",
    });
    expect(decode(calls[0]?.body)).toBe("q=1");
  });

  test("an unknown option exits 2 and names only the option", async () => {
    const result = await shell().exec("curl -sq https://example.com/a");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("curl: option -q is not supported\n");
    expect(calls).toHaveLength(0);
  });

  test("an unknown long option exits 2 without echoing its value", async () => {
    const result = await shell().exec(
      "curl --secret=hunter2 https://example.com/a"
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("curl: option --secret is not supported\n");
  });

  test("a missing URL exits 2", async () => {
    const result = await shell().exec("curl -s");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("curl: no URL specified\n");
  });

  test("a second URL exits 2", async () => {
    const result = await shell().exec(
      "curl -s https://example.com/a https://example.com/b"
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("curl: only one URL is supported\n");
  });

  test("without a fetcher it says network is off and exits 1", async () => {
    const result = await offlineShell().exec(
      "curl --bogus https://example.com"
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`curl: ${NETWORK_OFF_MESSAGE}\n`);
  });

  test("the output can be piped into a later command", async () => {
    next = answer("alpha\nbeta x\ngamma\n");
    const result = await shell().exec("curl -s https://example.com/a | grep x");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("beta x\n");
  });

  test("curl runs alongside file commands in one script", async () => {
    next = answer("remote text\n");
    const result = await shell().exec(
      "echo local > note.txt && curl -s https://example.com/a -o got.txt && cat note.txt got.txt"
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("local\nremote text\n");
  });
});
