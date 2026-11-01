import { afterEach, describe, expect, test } from "bun:test";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, which } from "bun";
import {
  makeSandbox,
  type ReleaseServer,
  type RunResult,
  readCalls,
  removeSandbox,
  renderTemplate,
  runScript,
  type Sandbox,
  serveReleases,
  stubCommand,
  stubDaemon,
  stubUname,
} from "./install-harness.ts";

const INSTALL_SH = fileURLToPath(new URL("./install.sh", import.meta.url));
const PRODUCT = "harbourmaster";
const FILE = "harbourmaster-linux-x64";
const V1 = "0.1.0+abc1234";
const V2 = "0.2.0+def5678";
const ENCODER = new TextEncoder();

// The real daemon logs its version with this prefix.
const daemonText = (version: string, exitCodes?: Record<string, number>) =>
  stubDaemon(PRODUCT, `[harbourmaster] ${version}`, exitCodes);

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const useSandbox = (): Sandbox => {
  const sandbox = makeSandbox();
  cleanups.push(() => removeSandbox(sandbox));
  stubCommand(sandbox, "systemctl");
  stubCommand(sandbox, "claude");
  stubUname(sandbox, "Linux", "x86_64");
  return sandbox;
};

const useServer = (
  version: string,
  exitCodes?: Record<string, number>,
  corruptHash = false
): ReleaseServer => {
  const server = serveReleases({
    corruptHash,
    latest: version,
    product: PRODUCT,
    versions: {
      [version]: { [FILE]: ENCODER.encode(daemonText(version, exitCodes)) },
    },
  });
  cleanups.push(server.stop);
  return server;
};

const script = (origin: string): string => renderTemplate(INSTALL_SH, origin);

const binPath = (sandbox: Sandbox): string =>
  join(sandbox.home, ".local", "bin", PRODUCT);

const binDir = (sandbox: Sandbox): string =>
  join(sandbox.home, ".local", "bin");

const install = (
  sandbox: Sandbox,
  origin: string,
  args: readonly string[] = [],
  extra: { mode?: "file" | "pipe"; systemd?: boolean } = {}
): Promise<RunResult> =>
  runScript({ args, sandbox, script: script(origin), ...extra });

describe("install.sh", () => {
  test("a fresh install lands the binary and runs install-service before any enrol", async () => {
    const sandbox = useSandbox();
    const server = useServer(V1, { "install-service": 0 });

    const result = await install(sandbox, server.origin);

    expect(result.exitCode).toBe(0);
    expect(readFileSync(binPath(sandbox), "utf8")).toBe(
      daemonText(V1, { "install-service": 0 })
    );
    expect(() => accessSync(binPath(sandbox), constants.X_OK)).not.toThrow();
    expect(readCalls(sandbox)).toEqual([
      "harbourmaster install-service",
      "harbourmaster --version",
    ]);
    expect(result.stdout).toContain(`harbourmaster ${V1} is installed`);
  });

  test("--code passes the code and the origin to enroll after install-service", async () => {
    const sandbox = useSandbox();
    const server = useServer(V1);

    const result = await install(
      sandbox,
      server.origin,
      ["--code", "ABC-123"],
      {
        mode: "pipe",
      }
    );

    expect(result.exitCode).toBe(0);
    expect(readCalls(sandbox)).toEqual([
      "harbourmaster install-service",
      `harbourmaster enroll ABC-123 --server ${server.origin}`,
      "harbourmaster --version",
    ]);
  });

  test("--no-service skips install-service", async () => {
    const sandbox = useSandbox();
    const server = useServer(V1);

    const result = await install(sandbox, server.origin, ["--no-service"]);

    expect(result.exitCode).toBe(0);
    expect(readCalls(sandbox)).toEqual(["harbourmaster --version"]);
  });

  test("--no-service with --code still enrols", async () => {
    const sandbox = useSandbox();
    const server = useServer(V1);

    const result = await install(sandbox, server.origin, [
      "--no-service",
      "--code",
      "XYZ",
    ]);

    expect(result.exitCode).toBe(0);
    expect(readCalls(sandbox)).toEqual([
      `harbourmaster enroll XYZ --server ${server.origin}`,
      "harbourmaster --version",
    ]);
  });

  test("a checksum mismatch is refused and leaves nothing in ~/.local/bin", async () => {
    const sandbox = useSandbox();
    const server = useServer(V1, undefined, true);

    const result = await install(sandbox, server.origin);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("expected");
    expect(result.stderr).toContain("got");
    expect(existsSync(binPath(sandbox))).toBe(false);
    expect(readdirSync(binDir(sandbox))).toEqual([]);
    expect(readCalls(sandbox)).toEqual([]);
  });

  test("a non-Linux OS is refused before any download", async () => {
    const sandbox = useSandbox();
    stubUname(sandbox, "Darwin", "x86_64");
    const server = useServer(V1);

    const result = await install(sandbox, server.origin);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "harbourmaster supports Linux x64 and arm64 only"
    );
    expect(server.requests).toEqual([]);
  });

  test("an unsupported architecture is refused before any download", async () => {
    const sandbox = useSandbox();
    stubUname(sandbox, "Linux", "riscv64");
    const server = useServer(V1);

    const result = await install(sandbox, server.origin);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "harbourmaster supports Linux x64 and arm64 only"
    );
    expect(server.requests).toEqual([]);
  });

  const enrolled = (sandbox: Sandbox) => {
    mkdirSync(join(sandbox.home, ".harbourmaster"), { recursive: true });
    writeFileSync(join(sandbox.home, ".harbourmaster", "config.json"), "{}\n");
    rmSync(sandbox.callsLog, { force: true });
  };

  test("a re-run on an enrolled machine replaces the binary and installs the service again so it runs the new one", async () => {
    const sandbox = useSandbox();
    const first = useServer(V1, { "install-service": 0 });
    expect((await install(sandbox, first.origin)).exitCode).toBe(0);
    enrolled(sandbox);

    const second = useServer(V2, { "install-service": 0 });
    const result = await install(sandbox, second.origin);

    expect(result.exitCode).toBe(0);
    expect(readFileSync(binPath(sandbox), "utf8")).toBe(
      daemonText(V2, { "install-service": 0 })
    );
    expect(result.stdout).toContain(`harbourmaster ${V2} is installed`);
    expect(readCalls(sandbox)).toEqual([
      "systemctl --user cat harbourmaster",
      "harbourmaster install-service",
      "harbourmaster --version",
    ]);
  });

  test("a re-run where no service is installed replaces the binary and exits 0", async () => {
    const sandbox = useSandbox();
    stubCommand(sandbox, "systemctl", ['[ "$2" = cat ] && exit 1']);
    const first = useServer(V1, { "install-service": 0 });
    expect(
      (await install(sandbox, first.origin, ["--no-service"])).exitCode
    ).toBe(0);
    enrolled(sandbox);

    const second = useServer(V2);
    const result = await install(sandbox, second.origin);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No harbourmaster service is installed");
    expect(readCalls(sandbox)).toEqual([
      "systemctl --user cat harbourmaster",
      "harbourmaster --version",
    ]);
  });

  test("a re-run with --code on an enrolled machine does not enrol again", async () => {
    const sandbox = useSandbox();
    const first = useServer(V1);
    expect((await install(sandbox, first.origin)).exitCode).toBe(0);
    enrolled(sandbox);

    const second = useServer(V2);
    const result = await install(sandbox, second.origin, ["--code", "USED-1"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("The code was not used");
    expect(readCalls(sandbox).join("\n")).not.toContain("enroll");
  });

  test("install-service exit 2 prints the linger fix and the install still succeeds", async () => {
    const sandbox = useSandbox();
    const server = useServer(V1, { "install-service": 2 });

    const result = await install(sandbox, server.origin);

    expect(result.exitCode).toBe(0);
    expect(existsSync(binPath(sandbox))).toBe(true);
    expect(result.stdout + result.stderr).toContain("loginctl enable-linger");
    expect(result.stdout + result.stderr).toContain("lingering");
  });

  test("without systemd it says so and does not call install-service", async () => {
    const sandbox = useSandbox();
    const server = useServer(V1);

    const result = await install(sandbox, server.origin, [], {
      systemd: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("systemd was not found");
    expect(result.stdout).toContain("harbourmaster run");
    expect(readCalls(sandbox)).toEqual(["harbourmaster --version"]);
  });

  test("the raw script parses under sh and dash", () => {
    for (const shell of ["sh", "dash"]) {
      const path = which(shell);
      expect(path).not.toBeNull();
      const check = spawnSync([path ?? shell, "-n", INSTALL_SH]);
      expect(check.stderr.toString()).toBe("");
      expect(check.exitCode).toBe(0);
    }
  });

  test("a script cut in half installs nothing", async () => {
    const sandbox = useSandbox();
    const server = useServer(V1, { "install-service": 0 });
    const full = script(server.origin);

    await runScript({
      args: [],
      mode: "file",
      sandbox,
      script: full.slice(0, Math.floor(full.length / 2)),
    });

    expect(existsSync(binPath(sandbox))).toBe(false);
    expect(readCalls(sandbox)).toEqual([]);
    expect(server.requests).toEqual([]);
  });
});
