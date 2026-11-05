import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  makeSandbox,
  readCalls,
  removeSandbox,
  renderTemplate,
  runScript,
  serveReleases,
  stubCommand,
  stubUname,
} from "./install-harness";

const sandboxes: ReturnType<typeof makeSandbox>[] = [];
const servers: ReturnType<typeof serveReleases>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop();
  }
  for (const sandbox of sandboxes.splice(0)) {
    removeSandbox(sandbox);
  }
});
const setup = (
  corruptHash = false,
  restartFailure = false,
  missingService = "",
  installFailure = false
) => {
  const sandbox = makeSandbox();
  sandboxes.push(sandbox);
  stubUname(sandbox, "Linux", "x86_64");
  stubCommand(sandbox, "id", ["echo 1000"]);
  stubCommand(sandbox, "systemctl", ["exit 1"]);
  const binary = `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/stub-calls.log"
test -z "\${AGENTUM_ENROLL_CODE:-}" || exit 90
case "$*" in *"service restart --instance one"*) ${restartFailure ? "exit 1" : ":"} ;; esac
case "$*" in
  "service status --instance ${missingService}") echo 'Problem: service missing' >&2; exit 5 ;;
  "service install "*) ${installFailure ? "exit 1" : ":"} ;;
esac
case "$1" in
  enroll)
    read -r code; test "$code" = secret || exit 1
    instance=office
    replacing=false
    while [ "$#" -gt 0 ]; do
      case "$1" in --instance) instance="$2"; shift ;; --replace) replacing=true ;; esac
      shift
    done
    root="$HOME/.config/agentum"
    if [ "$replacing" = false ]; then
      suffix=2
      while [ -f "$root/$instance/config.json" ]; do instance="office-$suffix"; suffix=$((suffix + 1)); done
    fi
    mkdir -p "$root/$instance"
    echo '{"machineId":"m","roles":["computer"]}' > "$root/$instance/config.json"
    echo new-credential > "$root/$instance/credential"
    printf '{"instance":"%s","machineId":"m","roles":["computer"]}\\n' "$instance"
    ;;
esac
`;
  const server = serveReleases({
    corruptHash,
    latest: "0.1.0+abc1234",
    product: "agentum-rs",
    versions: {
      "0.1.0+abc1234": {
        "agentum-linux-x64": new TextEncoder().encode(binary),
      },
    },
  });
  servers.push(server);
  return {
    sandbox,
    script: renderTemplate(
      join(import.meta.dir, "install-agentum.sh"),
      server.origin
    ),
    server,
  };
};
test("curl pipe enrols through stdin with origin, then installs a user service", async () => {
  const fixture = setup();
  const result = await runScript({ ...fixture, args: ["--code", "secret"] });
  expect(result.exitCode).toBe(0);
  expect(readCalls(fixture.sandbox)).toContain(
    `enroll --url ${fixture.server.origin} --code-stdin --json --run-as current`
  );
  expect(readCalls(fixture.sandbox)).toContain(
    "service install --user --run-as current --instance office --yes"
  );
  expect(result.stdout + result.stderr).not.toContain("secret");
  expect(result.stdout).toContain("Installed its user service.");
  expect(result.stdout).toContain("service status --instance office");
});
test("checksum failure never executes the binary", async () => {
  const fixture = setup(true);
  const result = await runScript({ ...fixture, args: ["--code", "secret"] });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("checksum mismatch");
  expect(
    readCalls(fixture.sandbox).some((call) => call.startsWith("enroll"))
  ).toBe(false);
});
test("replacement retires old files so a plain update restarts every instance", async () => {
  const fixture = setup();
  const config = join(fixture.sandbox.home, ".agentum/config.json");
  const unit = join(
    fixture.sandbox.home,
    ".config/systemd/user/agentum.service"
  );
  mkdirSync(join(fixture.sandbox.home, ".agentum"));
  mkdirSync(join(fixture.sandbox.home, ".config/systemd/user"), {
    recursive: true,
  });
  writeFileSync(config, "old credential");
  writeFileSync(unit, "old unit");
  const refused = await runScript(fixture);
  expect(refused.exitCode).not.toBe(0);
  expect(fixture.server.requests).toEqual([]);
  stubCommand(fixture.sandbox, "systemctl", [
    'case "$*" in *cat*) exit 1 ;; esac',
  ]);
  const replaced = await runScript({
    ...fixture,
    args: ["--replace-old", "--code", "secret"],
  });
  expect(replaced.exitCode).toBe(0);
  expect(existsSync(config)).toBe(false);
  expect(readFileSync(`${config}.replaced`, "utf8")).toBe("old credential");
  expect(existsSync(unit)).toBe(false);
  expect(readCalls(fixture.sandbox)).toContain(
    "systemctl --user disable --now agentum.service"
  );
  expect(readCalls(fixture.sandbox)).toContain(
    "systemctl --user daemon-reload"
  );
  expect(replaced.stdout).toContain("revoke the old machine");
  addInstances(fixture.sandbox.home);
  const updated = await runScript(fixture);
  expect(updated.exitCode).toBe(0);
  for (const name of ["one", "two"]) {
    expect(readCalls(fixture.sandbox)).toContain(
      `service restart --instance ${name}`
    );
  }
});
const addInstances = (home: string) => {
  for (const name of ["one", "two"]) {
    mkdirSync(join(home, ".config/agentum", name), { recursive: true });
    writeFileSync(join(home, ".config/agentum", name, "config.json"), "{}");
  }
};

test("rerun restarts every enrolled instance with a service", async () => {
  const fixture = setup();
  for (const name of ["one", "two"]) {
    mkdirSync(join(fixture.sandbox.home, ".config/agentum", name), {
      recursive: true,
    });
    writeFileSync(
      join(fixture.sandbox.home, ".config/agentum", name, "config.json"),
      "{}"
    );
  }
  const result = await runScript(fixture);
  expect(result.exitCode).toBe(0);
  expect(readCalls(fixture.sandbox)).toContain(
    "service restart --instance one"
  );
  expect(readCalls(fixture.sandbox)).toContain(
    "service restart --instance two"
  );
});

test("reads a code from stdin when run from a file", async () => {
  const fixture = setup();
  const result = await runScript({
    ...fixture,
    mode: "file",
    stdin: "secret\n",
  });
  expect(result.exitCode).toBe(0);
  expect(readCalls(fixture.sandbox)).toContain(
    "service install --user --run-as current --instance office --yes"
  );
  expect(result.stdout + result.stderr).not.toContain("secret");
});

test("root enrols and installs in system mode with the chosen run-as", async () => {
  const fixture = setup();
  stubCommand(fixture.sandbox, "id", ["echo 0"]);
  // Redirect the root destination as well as HOME so the test cannot touch a real binary.
  const script = fixture.script
    .replaceAll("/usr/local/bin", join(fixture.sandbox.root, "system-bin"))
    .replaceAll("/etc/agentum", join(fixture.sandbox.root, "system-config"));
  const result = await runScript({
    ...fixture,
    args: ["--code", "secret", "--run-as", "agent-user"],
    script,
  });
  expect(result.exitCode).toBe(0);
  expect(readCalls(fixture.sandbox)).toContain(
    `enroll --url ${fixture.server.origin} --code-stdin --json --run-as agent-user --system`
  );
  expect(readCalls(fixture.sandbox)).toContain(
    "service install --system --run-as agent-user --instance office --yes"
  );
});

test("an old unit alone refuses replacement", async () => {
  const fixture = setup();
  stubCommand(fixture.sandbox, "systemctl");
  const result = await runScript(fixture);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("--replace-old");
  expect(fixture.server.requests).toEqual([]);
});

test("environment code stays out of child argv and environment", async () => {
  const fixture = setup();
  stubCommand(fixture.sandbox, "id", [
    `test -z "\${AGENTUM_ENROLL_CODE:-}" || { echo CODE_ENV_LEAK >> "$HOME/stub-calls.log"; exit 90; }`,
    "echo 1000",
  ]);
  for (const name of [
    "curl",
    "sed",
    "awk",
    "head",
    "mkdir",
    "mktemp",
    "chmod",
    "mv",
    "sha256sum",
  ]) {
    stubCommand(fixture.sandbox, name, [
      `test -z "\${AGENTUM_ENROLL_CODE:-}" || exit 90`,
      `exec /usr/bin/${name} "$@"`,
    ]);
  }
  const result = await runScript({
    ...fixture,
    env: { AGENTUM_ENROLL_CODE: "secret" },
  });
  expect(result.exitCode).toBe(0);
  expect(result.argv.join(" ")).not.toContain("secret");
  expect(readCalls(fixture.sandbox)).not.toContain("CODE_ENV_LEAK");
  expect(readCalls(fixture.sandbox).join("\n")).not.toContain("secret");
});
test("non-root replacement refuses an old system unit before disabling anything", async () => {
  const fixture = setup();
  stubCommand(fixture.sandbox, "systemctl", [
    'case "$*" in "cat agentum.service") exit 0 ;; *) exit 1 ;; esac',
  ]);
  const result = await runScript({ ...fixture, args: ["--replace-old"] });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("run as root to replace the system unit");
  expect(readCalls(fixture.sandbox).join("\n")).not.toContain("disable");
});
for (const preservedHome of [false, true]) {
  test(`sudo replacement retires the invoking user files (preserved HOME: ${preservedHome})`, async () => {
    const fixture = setup();
    const home = preservedHome
      ? fixture.sandbox.home
      : join(fixture.sandbox.root, "invoker");
    mkdirSync(join(home, ".agentum"), { recursive: true });
    mkdirSync(join(home, ".config/systemd/user"), { recursive: true });
    writeFileSync(join(home, ".agentum/config.json"), "{}");
    writeFileSync(join(home, ".config/systemd/user/agentum.service"), "old");
    stubCommand(fixture.sandbox, "id", [
      'case "$*" in -u) echo 0 ;; *) echo 1000 ;; esac',
    ]);
    stubCommand(fixture.sandbox, "getent", [
      `echo 'dom:x:1000:1000::${home}:/bin/sh'`,
    ]);
    stubCommand(fixture.sandbox, "runuser", ['shift 3; exec "$@"']);
    stubCommand(fixture.sandbox, "systemctl", [
      'case "$*" in *cat*) exit 1 ;; esac',
    ]);
    const script = fixture.script.replaceAll(
      "/usr/local/bin",
      join(fixture.sandbox.root, "system-bin")
    );
    const result = await runScript({
      ...fixture,
      args: ["--replace-old", "--code", "secret"],
      env: { SUDO_USER: "dom" },
      script,
    });
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(home, ".agentum/config.json.replaced"))).toBe(true);
    expect(existsSync(join(home, ".config/systemd/user/agentum.service"))).toBe(
      false
    );
    expect(readCalls(fixture.sandbox)).toContain(
      "runuser -u dom -- env XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus systemctl --user disable --now agentum.service"
    );
  });
}
test("a failed restart names the instance and continues", async () => {
  const fixture = setup(false, true);
  addInstances(fixture.sandbox.home);
  const result = await runScript(fixture);
  expect(result.exitCode).toBe(0);
  expect(result.stderr.match(/could not restart one/g)).toHaveLength(1);
  expect(result.stdout).not.toContain("restarted one");
  expect(readCalls(fixture.sandbox)).toContain(
    "service restart --instance two"
  );
});
test("re-enrolment replaces the selected instance and restarts its saved service", async () => {
  const fixture = setup();
  addInstances(fixture.sandbox.home);
  const result = await runScript({
    ...fixture,
    args: ["--instance", "one"],
    env: { AGENTUM_ENROLL_CODE: "secret" },
  });
  expect(result.exitCode).toBe(0);
  expect(readCalls(fixture.sandbox)).toContain(
    `enroll --url ${fixture.server.origin} --code-stdin --json --instance one --replace`
  );
  expect(readCalls(fixture.sandbox)).not.toContain(
    "service install --user --run-as current --instance office --yes"
  );
  expect(
    readCalls(fixture.sandbox).filter(
      (call) => call === "service restart --instance one"
    )
  ).toHaveLength(1);
  expect(result.stdout).toContain("restarted one");
  expect(result.stdout).not.toContain("Installed its");
  expect(result.stdout).not.toContain("installed its");
});

test("root replacement retires the system unit before a plain update", async () => {
  const fixture = setup();
  const unit = join(fixture.sandbox.root, "agentum.service");
  const configRoot = join(fixture.sandbox.root, "system-config");
  mkdirSync(join(fixture.sandbox.home, ".agentum"));
  writeFileSync(join(fixture.sandbox.home, ".agentum/config.json"), "{}");
  writeFileSync(unit, "old unit");
  stubCommand(fixture.sandbox, "id", ["echo 0"]);
  stubCommand(fixture.sandbox, "systemctl", [
    'case "$*" in *cat*) exit 1 ;; esac',
  ]);
  const script = fixture.script
    .replaceAll("/usr/local/bin", join(fixture.sandbox.root, "system-bin"))
    .replaceAll("/etc/agentum", configRoot)
    .replaceAll("/etc/systemd/system/agentum.service", unit);
  const replaced = await runScript({
    ...fixture,
    args: ["--replace-old"],
    env: { AGENTUM_ENROLL_CODE: "secret" },
    script,
  });
  expect(replaced.exitCode).toBe(0);
  expect(existsSync(unit)).toBe(false);
  expect(readCalls(fixture.sandbox)).toContain(
    "systemctl disable --now agentum.service"
  );
  expect(readCalls(fixture.sandbox)).toContain("systemctl daemon-reload");
  for (const name of ["one", "two"]) {
    mkdirSync(join(configRoot, name), { recursive: true });
    writeFileSync(join(configRoot, name, "config.json"), "{}");
  }
  const updated = await runScript({ ...fixture, script });
  expect(updated.exitCode).toBe(0);
  for (const name of ["one", "two"]) {
    expect(readCalls(fixture.sandbox)).toContain(
      `service restart --instance ${name}`
    );
  }
});

test("a fresh code creates a second instance and preserves the sole existing enrolment", async () => {
  const fixture = setup();
  const directory = join(fixture.sandbox.home, ".config/agentum/office");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "config.json"), "original config");
  writeFileSync(join(directory, "credential"), "original credential");
  const result = await runScript({
    ...fixture,
    env: { AGENTUM_ENROLL_CODE: "secret" },
  });
  expect(result.exitCode).toBe(0);
  expect(readCalls(fixture.sandbox)).toContain(
    `enroll --url ${fixture.server.origin} --code-stdin --json --run-as current`
  );
  expect(readCalls(fixture.sandbox)).toContain(
    "service install --user --run-as current --instance office-2 --yes"
  );
  expect(existsSync(join(directory, "../office-2/config.json"))).toBe(true);
  expect(
    readFileSync(join(directory, "../office-2/credential"), "utf8").trim()
  ).toBe("new-credential");
  expect(readCalls(fixture.sandbox).join("\n")).not.toContain("--replace");
  expect(readFileSync(join(directory, "config.json"), "utf8")).toBe(
    "original config"
  );
  expect(readFileSync(join(directory, "credential"), "utf8")).toBe(
    "original credential"
  );
});

test("a fresh code with several instances creates another instance", async () => {
  const fixture = setup();
  addInstances(fixture.sandbox.home);
  const result = await runScript({
    ...fixture,
    env: { AGENTUM_ENROLL_CODE: "secret" },
  });
  expect(result.exitCode).toBe(0);
  expect(readCalls(fixture.sandbox)).toContain(
    `enroll --url ${fixture.server.origin} --code-stdin --json --run-as current`
  );
});

for (const system of [false, true]) {
  test(`update skips an enrolled instance without a unit (system: ${system})`, async () => {
    const fixture = setup(false, false, "one");
    let { script } = fixture;
    let configHome = fixture.sandbox.home;
    if (system) {
      stubCommand(fixture.sandbox, "id", ["echo 0"]);
      configHome = join(fixture.sandbox.root, "system-home");
      script = script
        .replaceAll("/usr/local/bin", join(fixture.sandbox.root, "system-bin"))
        .replaceAll("/etc/agentum", join(configHome, ".config/agentum"));
    }
    addInstances(configHome);
    const result = await runScript({ ...fixture, script });
    expect(result.exitCode).toBe(0);
    expect(readCalls(fixture.sandbox)).toContain(
      "service status --instance one"
    );
    expect(readCalls(fixture.sandbox)).not.toContain(
      "service restart --instance one"
    );
    expect(readCalls(fixture.sandbox)).toContain(
      "service restart --instance two"
    );
    expect(result.stdout).toContain("restarted two");
    expect(result.stdout).not.toContain("restarted one");
    expect(result.stderr).not.toContain("Problem:");
    expect(result.stderr).not.toContain("could not restart one");
  });
}

test("replacement with no unit reports enrolment without claiming service changes", async () => {
  const fixture = setup(false, false, "one");
  addInstances(fixture.sandbox.home);
  const result = await runScript({
    ...fixture,
    args: ["--instance", "one"],
    env: { AGENTUM_ENROLL_CODE: "secret" },
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Enrolled one.");
  expect(result.stdout).not.toContain("restarted one");
  expect(result.stdout).not.toContain("Installed its");
  expect(readCalls(fixture.sandbox)).not.toContain(
    "service restart --instance one"
  );
  expect(result.stderr).not.toContain("Problem:");
  expect(result.stderr).not.toContain("could not restart one");
});

test("failed replacement restart is attempted once and never claims success", async () => {
  const fixture = setup(false, true);
  addInstances(fixture.sandbox.home);
  const result = await runScript({
    ...fixture,
    args: ["--instance", "one"],
    env: { AGENTUM_ENROLL_CODE: "secret" },
  });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.match(/could not restart one/g)).toHaveLength(1);
  expect(result.stdout).not.toContain("restarted one");
  expect(result.stdout).not.toContain("Installed its");
});

test("failed service install never claims it installed a service", async () => {
  const fixture = setup(false, false, "", true);
  const result = await runScript({ ...fixture, args: ["--code", "secret"] });
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toContain("Enrolled office.");
  expect(result.stdout).not.toContain("Installed its");
  expect(result.stdout).not.toContain("installed its");
});
