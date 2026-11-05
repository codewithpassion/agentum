// Test harness for the release install scripts. It makes a temp HOME and a stub
// bin directory, serves a fixture release over a local Bun server, and runs a
// rendered script with a clean environment. Stubs replace the daemon, `uname`,
// `systemctl` and `claude`, so nothing touches the real HOME, ~/.local/bin,
// systemd or sudo.

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve, spawn } from "bun";
import { renderInstallScript } from "./install-script.ts";
import { type Manifest, serializeManifest } from "./manifest.ts";

/** Single-quotes a value for `sh`. */
const shQuote = (value: string): string =>
  `'${value.replaceAll("'", `'\\''`)}'`;

const lines = (...rows: string[]): string => `${rows.join("\n")}\n`;

export interface Sandbox {
  readonly callsLog: string;
  readonly home: string;
  readonly root: string;
  readonly stubBin: string;
  readonly systemdDir: string;
}

export const makeSandbox = (): Sandbox => {
  const root = mkdtempSync(join(tmpdir(), "hm-install-"));
  const home = join(root, "home");
  const stubBin = join(root, "bin");
  const systemdDir = join(root, "systemd");
  mkdirSync(home);
  mkdirSync(stubBin);
  mkdirSync(systemdDir);
  return {
    callsLog: join(home, "stub-calls.log"),
    home,
    root,
    stubBin,
    systemdDir,
  };
};

export const removeSandbox = (sandbox: Sandbox): void => {
  rmSync(sandbox.root, { force: true, recursive: true });
};

/** The lines the stubs logged to `$HOME/stub-calls.log`, in order. */
export const readCalls = (sandbox: Sandbox): string[] =>
  existsSync(sandbox.callsLog)
    ? readFileSync(sandbox.callsLog, "utf8").split("\n").filter(Boolean)
    : [];

const writeExecutable = (path: string, body: string): void => {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
};

/**
 * A stub command in the stub bin dir. It logs `<name> <argv>` to the calls log
 * and runs `body` after that.
 */
export const stubCommand = (
  sandbox: Sandbox,
  name: string,
  body: string[] = []
): void => {
  writeExecutable(
    join(sandbox.stubBin, name),
    lines(
      "#!/bin/sh",
      `printf '%s %s\\n' ${shQuote(name)} "$*" >> "$HOME/stub-calls.log"`,
      ...body,
      "exit 0"
    )
  );
};

/** A fake `uname`. `-s` and `-m` print the given values, anything else the system. */
export const stubUname = (
  sandbox: Sandbox,
  system: string,
  machine: string
): void => {
  writeExecutable(
    join(sandbox.stubBin, "uname"),
    lines(
      "#!/bin/sh",
      'case "$1" in',
      `  -s) echo ${shQuote(system)} ;;`,
      `  -m) echo ${shQuote(machine)} ;;`,
      `  *) echo ${shQuote(system)} ;;`,
      "esac"
    )
  );
};

/**
 * The text of a stub daemon binary. It logs its argv, prints `version` for
 * `versionArg` (`--version` for agentum, `version` for hm-computer), and
 * exits with `exitCodes[subcommand]` for a subcommand listed there, so a test
 * can make `install-service` exit 2.
 */
export const stubDaemon = (
  name: string,
  version: string,
  exitCodes: Record<string, number> = {},
  versionArg = "--version"
): string => {
  const cases = Object.entries(exitCodes).map(
    ([subcommand, code]) =>
      `  ${shQuote(subcommand)}) echo ${shQuote(`stub ${subcommand} exit ${code}`)} >&2; exit ${code} ;;`
  );
  return lines(
    "#!/bin/sh",
    `printf '%s %s\\n' ${shQuote(name)} "$*" >> "$HOME/stub-calls.log"`,
    'case "$1" in',
    `  ${shQuote(versionArg)}) echo ${shQuote(version)}; exit 0 ;;`,
    ...cases,
    "esac",
    "exit 0"
  );
};

export interface ReleaseFixture {
  /** Lists a checksum of other bytes for every file, so the download fails verification. */
  readonly corruptHash?: boolean;
  /** The version `latest.json` names. */
  readonly latest: string;
  readonly product: string;
  /** File bytes by version, then by file name. */
  readonly versions: Readonly<
    Record<string, Readonly<Record<string, Uint8Array<ArrayBuffer>>>>
  >;
}

export interface ReleaseServer {
  readonly origin: string;
  /** Every request path the server has answered, in order. */
  readonly requests: string[];
  readonly stop: () => void;
}

const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * Serves `/releases/<product>/latest.json` and `/releases/<product>/<version>/<file>`
 * on a free loopback port.
 */
export const serveReleases = (fixture: ReleaseFixture): ReleaseServer => {
  const latestFiles = fixture.versions[fixture.latest] ?? {};
  const manifest: Manifest = {
    files: Object.fromEntries(
      Object.entries(latestFiles).map(([file, bytes]) => [
        file,
        {
          sha256: fixture.corruptHash
            ? sha256Hex(new TextEncoder().encode(`not ${file}`))
            : sha256Hex(bytes),
          size: bytes.byteLength,
        },
      ])
    ),
    product: fixture.product as Manifest["product"],
    version: fixture.latest as Manifest["version"],
  };
  const latestJson = serializeManifest(manifest);
  const prefix = `/releases/${fixture.product}/`;
  const requests: string[] = [];
  const server = serve({
    fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(path);
      if (!path.startsWith(prefix)) {
        return new Response("not found", { status: 404 });
      }
      const rest = path.slice(prefix.length);
      if (rest === "latest.json") {
        return new Response(latestJson, {
          headers: { "content-type": "application/json" },
        });
      }
      const [version, file, ...extra] = rest.split("/");
      const bytes =
        extra.length === 0 && version !== undefined && file !== undefined
          ? fixture.versions[version]?.[file]
          : undefined;
      return bytes === undefined
        ? new Response("not found", { status: 404 })
        : new Response(bytes);
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
};

/** The script template with `origin` filled in, as the server renders it. */
export const renderTemplate = (templatePath: string, origin: string): string =>
  renderInstallScript(readFileSync(templatePath, "utf8"), origin);

export interface RunOptions {
  readonly args?: readonly string[];
  /** `pipe` runs `sh -s -- <args>` with the script on stdin, as users do. `file` runs it from a file. */
  readonly mode?: "file" | "pipe";
  readonly sandbox: Sandbox;
  readonly script: string;
  /** Code input when running the script from a file. */
  readonly stdin?: string;
  /** Whether the systemd run dir exists. */
  readonly systemd?: boolean;
}

export interface RunResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

/** Runs a script with `sh` and a clean environment: only HOME, PATH and the systemd dir. */
export const runScript = async (options: RunOptions): Promise<RunResult> => {
  const { args = [], mode = "pipe", sandbox, script } = options;
  const systemd = options.systemd ?? true;
  const env = {
    HM_SYSTEMD_RUN_DIR: systemd
      ? sandbox.systemdDir
      : join(sandbox.root, "no-systemd"),
    HOME: sandbox.home,
    PATH: [sandbox.stubBin, "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
  };
  const proc =
    mode === "file"
      ? (() => {
          const path = join(sandbox.root, "install.sh");
          writeFileSync(path, script);
          return spawn(["sh", path, ...args], {
            env,
            stderr: "pipe",
            stdin:
              options.stdin === undefined
                ? "ignore"
                : new Blob([options.stdin]),
            stdout: "pipe",
          });
        })()
      : spawn(["sh", "-s", "--", ...args], {
          env,
          stderr: "pipe",
          stdin: new Blob([script]),
          stdout: "pipe",
        });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stderr, stdout };
};
