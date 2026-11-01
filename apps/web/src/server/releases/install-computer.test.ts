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
  stubDaemon,
  stubUname,
} from "./install-harness.ts";
import { PRODUCT_FILES } from "./manifest.ts";

const INSTALL_SH = fileURLToPath(
  new URL("./install-computer.sh", import.meta.url)
);
const PRODUCT = "hm-computer";
const LINUX_AMD64 = "hm-computer_linux_amd64";
const DARWIN_ARM64 = "hm-computer_darwin_arm64";
const V1 = "0.1.0+abc1234";
const V2 = "0.2.0+def5678";
const ENCODER = new TextEncoder();

const binaryText = (
  version: string,
  exitCodes: Record<string, number> = {}
): string => stubDaemon(PRODUCT, version, exitCodes, "version");

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const useSandbox = (system = "Linux", machine = "x86_64"): Sandbox => {
  const sandbox = makeSandbox();
  cleanups.push(() => removeSandbox(sandbox));
  stubUname(sandbox, system, machine);
  return sandbox;
};

/** Serves every file of the product, so the platform under test picks its own. */
const useServer = (
  version: string,
  corruptHash = false,
  exitCodes?: Record<string, number>
): ReleaseServer => {
  const bytes = ENCODER.encode(binaryText(version, exitCodes));
  const server = serveReleases({
    corruptHash,
    latest: version,
    product: PRODUCT,
    versions: {
      [version]: Object.fromEntries(
        PRODUCT_FILES[PRODUCT].map((file) => [file, bytes])
      ),
    },
  });
  cleanups.push(server.stop);
  return server;
};

const script = (origin: string): string => renderTemplate(INSTALL_SH, origin);

const binDir = (sandbox: Sandbox): string =>
  join(sandbox.home, ".local", "bin");

const binPath = (sandbox: Sandbox): string => join(binDir(sandbox), PRODUCT);

const install = (
  sandbox: Sandbox,
  origin: string,
  args: readonly string[] = [],
  mode: "file" | "pipe" = "pipe"
): Promise<RunResult> =>
  runScript({ args, mode, sandbox, script: script(origin) });

describe("install-computer.sh", () => {
  test("a good install on Linux amd64 lands the binary and prints the enrol step", async () => {
    const sandbox = useSandbox("Linux", "x86_64");
    const server = useServer(V1);

    const result = await install(sandbox, server.origin);

    expect(result.exitCode).toBe(0);
    expect(readFileSync(binPath(sandbox), "utf8")).toBe(binaryText(V1));
    expect(() => accessSync(binPath(sandbox), constants.X_OK)).not.toThrow();
    expect(server.requests).toContain(
      `/releases/${PRODUCT}/${V1}/${LINUX_AMD64}`
    );
    expect(readCalls(sandbox)).toEqual(["hm-computer version"]);
    expect(result.stdout).toContain(V1);
    expect(result.stdout).toContain(
      `enroll --url ${server.origin} --code <code>`
    );
  });

  test("a good install on Darwin arm64 fetches the darwin file", async () => {
    const sandbox = useSandbox("Darwin", "arm64");
    const server = useServer(V1);

    const result = await install(sandbox, server.origin);

    expect(result.exitCode).toBe(0);
    expect(readFileSync(binPath(sandbox), "utf8")).toBe(binaryText(V1));
    expect(server.requests).toContain(
      `/releases/${PRODUCT}/${V1}/${DARWIN_ARM64}`
    );
    expect(server.requests).not.toContain(
      `/releases/${PRODUCT}/${V1}/${LINUX_AMD64}`
    );
  });

  test("--code runs enroll with the origin and the code, then names the start command", async () => {
    const sandbox = useSandbox();
    const server = useServer(V1);

    const result = await install(sandbox, server.origin, ["--code", "ABC-123"]);

    expect(result.exitCode).toBe(0);
    expect(readCalls(sandbox)).toEqual([
      `hm-computer enroll --url ${server.origin} --code ABC-123`,
      "hm-computer version",
    ]);
    expect(result.stdout).toContain("hm-computer run");
  });

  test("a failed enrol stops the install with an error", async () => {
    const sandbox = useSandbox();
    const server = useServer(V1, false, { enroll: 1 });

    const result = await install(sandbox, server.origin, ["--code", "BAD"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("enrolment failed");
  });

  test("a checksum mismatch is refused and leaves nothing in ~/.local/bin", async () => {
    const sandbox = useSandbox();
    const server = useServer(V1, true);

    const result = await install(sandbox, server.origin);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("expected");
    expect(result.stderr).toContain("got");
    expect(existsSync(binPath(sandbox))).toBe(false);
    expect(readdirSync(binDir(sandbox))).toEqual([]);
    expect(readCalls(sandbox)).toEqual([]);
  });

  test.each([
    ["Windows under Git Bash", "MINGW64_NT-10.0", "x86_64"],
    ["Linux on riscv64", "Linux", "riscv64"],
  ])(
    "an unsupported platform (%s) is refused before any download",
    async (_, system, machine) => {
      const sandbox = useSandbox(system, machine);
      const server = useServer(V1);

      const result = await install(sandbox, server.origin);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("hm-computer supports");
      expect(server.requests).toEqual([]);
      expect(existsSync(binPath(sandbox))).toBe(false);
    }
  );

  test("a re-run replaces the binary and keeps the existing enrolment", async () => {
    const sandbox = useSandbox();
    const first = useServer(V1);
    expect((await install(sandbox, first.origin)).exitCode).toBe(0);

    mkdirSync(join(sandbox.home, ".hm"), { recursive: true });
    writeFileSync(join(sandbox.home, ".hm", "config.json"), "{}\n");
    rmSync(sandbox.callsLog, { force: true });

    const second = useServer(V2);
    const result = await install(sandbox, second.origin);

    expect(result.exitCode).toBe(0);
    expect(readFileSync(binPath(sandbox), "utf8")).toBe(binaryText(V2));
    expect(result.stdout).toContain("already enrolled");
    expect(result.stdout).toContain("Restart hm-computer");
    expect(readCalls(sandbox)).toEqual(["hm-computer version"]);
  });

  test("a re-run with --code on an enrolled machine does not enrol again", async () => {
    const sandbox = useSandbox();
    const first = useServer(V1);
    expect((await install(sandbox, first.origin)).exitCode).toBe(0);
    mkdirSync(join(sandbox.home, ".hm"), { recursive: true });
    writeFileSync(join(sandbox.home, ".hm", "config.json"), "{}\n");
    rmSync(sandbox.callsLog, { force: true });

    const second = useServer(V2);
    const result = await install(sandbox, second.origin, ["--code", "USED-1"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("The code was not used");
    expect(readCalls(sandbox)).toEqual(["hm-computer version"]);
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
    const server = useServer(V1);
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
