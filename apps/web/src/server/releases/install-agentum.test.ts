import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
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
const setup = (corruptHash = false) => {
  const sandbox = makeSandbox();
  sandboxes.push(sandbox);
  stubUname(sandbox, "Linux", "x86_64");
  stubCommand(sandbox, "id", ["echo 1000"]);
  stubCommand(sandbox, "systemctl", ["exit 1"]);
  const binary = `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/stub-calls.log"
case "$1" in
  enroll) read -r code; test "$code" = secret; echo '{"instance":"office","machineId":"m","roles":["computer"]}' ;;
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
test("old config refuses before downloading; replacement stops the old unit", async () => {
  const fixture = setup();
  mkdirSync(join(fixture.sandbox.home, ".agentum"));
  writeFileSync(join(fixture.sandbox.home, ".agentum/config.json"), "{}");
  const refused = await runScript(fixture);
  expect(refused.exitCode).not.toBe(0);
  expect(fixture.server.requests).toEqual([]);
  stubCommand(fixture.sandbox, "systemctl");
  const replaced = await runScript({
    ...fixture,
    args: ["--replace-old", "--code", "secret"],
  });
  expect(replaced.exitCode).toBe(0);
  expect(readCalls(fixture.sandbox)).toContain(
    "systemctl --user disable --now agentum.service"
  );
  expect(replaced.stdout).toContain("revoke the old machine");
});
test("rerun restarts every enrolled instance", async () => {
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
