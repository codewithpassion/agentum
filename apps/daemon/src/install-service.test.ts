import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sudoersFile } from "./agent-user.ts";
import type { CommandResult, CommandRunner } from "./command.ts";
import { EXIT_FAILURE, EXIT_LINGER_MISSING, EXIT_OK } from "./exit-codes.ts";
import {
  installServiceCommand,
  LEGACY_SERVICE_NAME,
  SERVICE_NAME,
  serviceUnit,
  serviceUnitPath,
} from "./install-service.ts";
import { collectingLogger } from "./log.ts";

const BINARY = "/usr/local/bin/agentum";
const CLAUDE = "/opt/claude/bin/claude";
const USER = "dom";

const dirs: string[] = [];

const tempDirectory = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "agentum-install-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

const success: CommandResult = { exitCode: 0, stderr: "", stdout: "" };
const failure: CommandResult = { exitCode: 1, stderr: "no", stdout: "" };
const ok = (stdout: string): CommandResult => ({
  exitCode: 0,
  stderr: "",
  stdout,
});

type Answer = CommandResult | ((command: string[]) => CommandResult);

/**
 * A runner that records each command as one line and answers by prefix. Every
 * command succeeds with no output unless an override says otherwise, and the
 * linger probe reports lingering on.
 */
const fakeHost = (overrides: Record<string, Answer> = {}) => {
  const ran: string[] = [];
  const answers: Record<string, Answer> = {
    loginctl: ok("Linger=yes\n"),
    ...overrides,
  };
  const run: CommandRunner = (command) => {
    const line = command.join(" ");
    ran.push(line);
    const prefix = Object.keys(answers).find((key) => line.startsWith(key));
    const answer = prefix === undefined ? success : answers[prefix];
    if (typeof answer === "function") {
      return Promise.resolve(answer(command));
    }
    return Promise.resolve(answer ?? success);
  };
  return { ran, run };
};

const hasLine = (ran: string[], prefix: string): boolean =>
  ran.some((line) => line.startsWith(prefix));

test("serviceUnit quotes ExecStart and keeps the restart rules", () => {
  const unit = serviceUnit(BINARY);
  expect(unit).toContain(`ExecStart="${BINARY}" run\n`);
  expect(unit).toContain("RestartPreventExitStatus=3");
  expect(unit).toContain("WantedBy=default.target");
});

test("serviceUnit escapes a path with a space, a percent sign and a dollar sign", () => {
  expect(serviceUnit("/opt/my apps/50%off/a$b/agentum")).toContain(
    'ExecStart="/opt/my apps/50%%off/a$$b/agentum" run\n'
  );
});

test("serviceUnit escapes a quote and a backslash in the path", () => {
  expect(serviceUnit('/x/"a"\\b')).toContain(
    'ExecStart="/x/\\"a\\"\\\\b" run\n'
  );
});

test("the happy path writes the unit, the agent user and the sudoers rule", async () => {
  const home = tempDirectory();
  const tmp = tempDirectory();
  let staged = "";
  let stagedContent = "";
  const { ran, run } = fakeHost({
    "id -u": failure,
    "sudo visudo": (command) => {
      staged = command.at(-1) ?? "";
      stagedContent = readFileSync(staged, "utf8");
      return success;
    },
  });
  const lines: string[] = [];

  const code = await installServiceCommand({
    binaryPath: BINARY,
    claudeBinary: CLAUDE,
    getuid: () => 1000,
    home,
    log: collectingLogger(lines),
    platform: "linux",
    run,
    tempDir: tmp,
    username: USER,
  });

  expect(readFileSync(serviceUnitPath(home), "utf8")).toBe(serviceUnit(BINARY));
  expect(ran).toContain(
    "sudo useradd --system --create-home --home-dir /home/hm-agent --shell /bin/bash hm-agent"
  );
  expect(ran).toContain(`sudo visudo -cf ${staged}`);
  expect(ran).toContain(
    `sudo install -m 0440 -o root -g root ${staged} /etc/sudoers.d/agentum-${USER}`
  );
  expect(stagedContent).toBe(sudoersFile(USER, CLAUDE));
  expect(ran).toContain(`sudo rm -f /etc/sudoers.d/harbourmaster-${USER}`);
  expect(readdirSync(tmp)).toEqual([]);
  expect(code).toBe(EXIT_OK);
});

test("an existing hm-agent user skips useradd but still installs the sudoers rule", async () => {
  const { ran, run } = fakeHost();

  const code = await installServiceCommand({
    binaryPath: BINARY,
    claudeBinary: CLAUDE,
    getuid: () => 1000,
    home: tempDirectory(),
    log: collectingLogger([]),
    platform: "linux",
    run,
    tempDir: tempDirectory(),
    username: USER,
  });

  expect(hasLine(ran, "sudo useradd")).toBe(false);
  expect(hasLine(ran, "sudo visudo -cf")).toBe(true);
  expect(hasLine(ran, "sudo install -m 0440")).toBe(true);
  expect(code).toBe(EXIT_OK);
});

test("a failed useradd falls back to single_user and still installs the unit", async () => {
  const home = tempDirectory();
  const { ran, run } = fakeHost({
    "id -u": failure,
    "sudo useradd": { exitCode: 1, stderr: "Permission denied\n", stdout: "" },
  });
  const lines: string[] = [];

  const code = await installServiceCommand({
    binaryPath: BINARY,
    claudeBinary: CLAUDE,
    getuid: () => 1000,
    home,
    log: collectingLogger(lines),
    platform: "linux",
    run,
    tempDir: tempDirectory(),
    username: USER,
  });

  expect(existsSync(serviceUnitPath(home))).toBe(true);
  expect(hasLine(ran, "systemctl --user daemon-reload")).toBe(true);
  expect(hasLine(ran, "sudo install")).toBe(false);
  expect(lines.some((line) => line.includes("single_user"))).toBe(true);
  expect(lines).toContain("could not create hm-agent: Permission denied");
  expect(code).toBe(EXIT_OK);
});

test("a visudo failure installs nothing and removes the temp directory", async () => {
  const tmp = tempDirectory();
  const { ran, run } = fakeHost({
    "id -u": failure,
    "sudo visudo": failure,
  });
  const lines: string[] = [];

  const code = await installServiceCommand({
    binaryPath: BINARY,
    claudeBinary: CLAUDE,
    getuid: () => 1000,
    home: tempDirectory(),
    log: collectingLogger(lines),
    platform: "linux",
    run,
    tempDir: tmp,
    username: USER,
  });

  expect(hasLine(ran, "sudo install")).toBe(false);
  expect(readdirSync(tmp)).toEqual([]);
  expect(lines.some((line) => line.includes("single_user"))).toBe(true);
  expect(code).toBe(EXIT_OK);
});

test("without claude on the PATH there are no sudoers steps and the install carries on", async () => {
  const { ran, run } = fakeHost({
    "id -u": failure,
    which: failure,
  });
  const lines: string[] = [];

  const code = await installServiceCommand({
    getuid: () => 1000,
    home: tempDirectory(),
    log: collectingLogger(lines),
    platform: "linux",
    run,
    tempDir: tempDirectory(),
    username: USER,
  });

  expect(hasLine(ran, "sudo visudo")).toBe(false);
  expect(hasLine(ran, "sudo install")).toBe(false);
  expect(lines.some((line) => line.includes("install Claude Code"))).toBe(true);
  expect(lines.some((line) => line.includes("single_user"))).toBe(true);
  expect(code).toBe(EXIT_OK);
});

test("when sudo will not run claude as hm-agent the install falls back to single_user", async () => {
  const { run } = fakeHost({
    "id -u": failure,
    "sudo -n -u": failure,
  });
  const lines: string[] = [];

  const code = await installServiceCommand({
    binaryPath: BINARY,
    claudeBinary: CLAUDE,
    getuid: () => 1000,
    home: tempDirectory(),
    log: collectingLogger(lines),
    platform: "linux",
    run,
    tempDir: tempDirectory(),
    username: USER,
  });

  expect(lines.some((line) => line.includes("single_user"))).toBe(true);
  expect(code).toBe(EXIT_OK);
});

test("with a config present the unit is restarted last", async () => {
  const configPath = join(tempDirectory(), "config.json");
  writeFileSync(configPath, "{}\n");
  const { ran, run } = fakeHost();

  await installServiceCommand({
    binaryPath: BINARY,
    claudeBinary: CLAUDE,
    configPath,
    getuid: () => 1000,
    home: tempDirectory(),
    log: collectingLogger([]),
    platform: "linux",
    run,
    tempDir: tempDirectory(),
    username: USER,
  });

  const systemctl = ran.filter((line) => line.startsWith("systemctl"));
  expect(systemctl).toEqual([
    "systemctl --user daemon-reload",
    "systemctl --user enable agentum",
    "systemctl --user restart agentum",
  ]);
});

test("refresh rewrites the unit and restarts it without touching the agent user or sudoers", async () => {
  const configPath = join(tempDirectory(), "config.json");
  writeFileSync(configPath, "{}\n");
  const home = tempDirectory();
  const { ran, run } = fakeHost();

  const code = await installServiceCommand({
    binaryPath: BINARY,
    configPath,
    getuid: () => 1000,
    home,
    log: collectingLogger([]),
    platform: "linux",
    refresh: true,
    run,
    tempDir: tempDirectory(),
    username: USER,
  });

  expect(code).toBe(EXIT_OK);
  expect(readFileSync(serviceUnitPath(home), "utf8")).toContain(
    `ExecStart="${BINARY}" run`
  );
  expect(ran.filter((line) => line.startsWith("systemctl"))).toEqual([
    "systemctl --user daemon-reload",
    "systemctl --user enable agentum",
    "systemctl --user restart agentum",
  ]);
  expect(hasLine(ran, "sudo")).toBe(false);
  expect(hasLine(ran, "claude")).toBe(false);
});

test("with no config the unit is not restarted and the log says to enroll", async () => {
  const { ran, run } = fakeHost();
  const lines: string[] = [];

  await installServiceCommand({
    binaryPath: BINARY,
    claudeBinary: CLAUDE,
    configPath: join(tempDirectory(), "missing.json"),
    getuid: () => 1000,
    home: tempDirectory(),
    log: collectingLogger(lines),
    platform: "linux",
    run,
    tempDir: tempDirectory(),
    username: USER,
  });

  expect(ran.filter((line) => line.startsWith("systemctl"))).toEqual([
    "systemctl --user daemon-reload",
    "systemctl --user enable agentum",
  ]);
  expect(
    lines.some((line) =>
      line.includes(
        `agentum enroll <code> --server <url>, then systemctl --user restart ${SERVICE_NAME}`
      )
    )
  ).toBe(true);
});

test("lingering off returns the linger exit code", async () => {
  const { run } = fakeHost({ loginctl: ok("Linger=no\n") });
  const lines: string[] = [];

  const code = await installServiceCommand({
    binaryPath: BINARY,
    claudeBinary: CLAUDE,
    getuid: () => 1000,
    home: tempDirectory(),
    log: collectingLogger(lines),
    platform: "linux",
    run,
    tempDir: tempDirectory(),
    username: USER,
  });

  expect(code).toBe(EXIT_LINGER_MISSING);
  expect(lines).toContain(`lingering is off for ${USER}`);
});

test("a systemctl failure returns failure and names the linger hint", async () => {
  const { run } = fakeHost({
    "systemctl --user daemon-reload": {
      exitCode: 1,
      stderr: "Failed to connect to bus\n",
      stdout: "",
    },
  });
  const lines: string[] = [];

  const code = await installServiceCommand({
    binaryPath: BINARY,
    claudeBinary: CLAUDE,
    getuid: () => 1000,
    home: tempDirectory(),
    log: collectingLogger(lines),
    platform: "linux",
    run,
    tempDir: tempDirectory(),
    username: USER,
  });

  expect(code).toBe(EXIT_FAILURE);
  expect(lines).toContain(
    "systemctl --user daemon-reload failed: Failed to connect to bus"
  );
  expect(
    lines.some((line) => line.includes(`loginctl enable-linger ${USER}`))
  ).toBe(true);
});

test("running as root returns failure and writes nothing", async () => {
  const home = tempDirectory();
  const { ran, run } = fakeHost();
  const lines: string[] = [];

  const code = await installServiceCommand({
    binaryPath: BINARY,
    claudeBinary: CLAUDE,
    getuid: () => 0,
    home,
    log: collectingLogger(lines),
    platform: "linux",
    run,
    tempDir: tempDirectory(),
    username: USER,
  });

  expect(code).toBe(EXIT_FAILURE);
  expect(existsSync(serviceUnitPath(home))).toBe(false);
  expect(ran).toEqual([]);
  expect(lines.some((line) => line.includes("not as root"))).toBe(true);
});

test("darwin returns failure and writes nothing", async () => {
  const home = tempDirectory();
  const { ran, run } = fakeHost();
  const lines: string[] = [];

  const code = await installServiceCommand({
    getuid: () => 1000,
    home,
    log: collectingLogger(lines),
    platform: "darwin",
    run,
    tempDir: tempDirectory(),
    username: USER,
  });

  expect(code).toBe(EXIT_FAILURE);
  expect(existsSync(serviceUnitPath(home))).toBe(false);
  expect(ran).toEqual([]);
  expect(lines).toContain("launchd is not supported yet");
});

test("the unit lives under the home directory's systemd user folder", () => {
  expect(serviceUnitPath("/home/dom")).toBe(
    "/home/dom/.config/systemd/user/agentum.service"
  );
});

test("an install from before the rename has its harbourmaster unit stopped and removed", async () => {
  const configPath = join(tempDirectory(), "config.json");
  writeFileSync(configPath, "{}\n");
  const home = tempDirectory();
  const legacyPath = serviceUnitPath(home, LEGACY_SERVICE_NAME);
  mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
  writeFileSync(legacyPath, serviceUnit("/home/dom/.local/bin/harbourmaster"));
  const { ran, run } = fakeHost();

  const code = await installServiceCommand({
    binaryPath: BINARY,
    configPath,
    getuid: () => 1000,
    home,
    log: collectingLogger([]),
    platform: "linux",
    refresh: true,
    run,
    tempDir: tempDirectory(),
    username: USER,
  });

  expect(code).toBe(EXIT_OK);
  expect(existsSync(legacyPath)).toBe(false);
  expect(readFileSync(serviceUnitPath(home), "utf8")).toBe(serviceUnit(BINARY));
  expect(ran.filter((line) => line.startsWith("systemctl"))).toEqual([
    "systemctl --user disable --now harbourmaster",
    "systemctl --user daemon-reload",
    "systemctl --user enable agentum",
    "systemctl --user restart agentum",
  ]);
});

test("without a harbourmaster unit nothing old is stopped", async () => {
  const { ran, run } = fakeHost();

  await installServiceCommand({
    binaryPath: BINARY,
    getuid: () => 1000,
    home: tempDirectory(),
    log: collectingLogger([]),
    platform: "linux",
    refresh: true,
    run,
    tempDir: tempDirectory(),
    username: USER,
  });

  expect(hasLine(ran, "systemctl --user disable")).toBe(false);
});
