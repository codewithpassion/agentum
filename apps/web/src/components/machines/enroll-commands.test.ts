import { expect, test } from "bun:test";
import {
  agentumCommand,
  agentumDockerCommand,
  agentumInstallCommand,
  IMAGE_OWNER,
} from "./enroll-commands";

const ORIGIN = "https://hm.example.test";
const CODE = "hm_enr_abc123";

test("the both-role command installs the new client", () => {
  expect(agentumCommand(ORIGIN, CODE)).toBe(
    `curl -fsSL ${ORIGIN}/install-agentum.sh | AGENTUM_ENROLL_CODE=${CODE} sh`
  );
});

test("Rust Docker commands use the new image, environment code and persistent state", () => {
  for (const desktop of [false, true]) {
    const command = agentumDockerCommand(ORIGIN, CODE, desktop);
    expect(command).toContain(
      `ghcr.io/${IMAGE_OWNER}/agentum:${desktop ? "desktop" : "latest"}`
    );
    expect(command).toContain(`-e AGENTUM_ENROLL_CODE=${CODE}`);
    expect(command).toContain(`--url ${ORIGIN}`);
    expect(command).not.toContain("--code");
    expect(command).toContain(":/var/lib/agentum");
    if (desktop) {
      for (const flag of [
        "--shm-size=256m",
        "--cap-drop ALL",
        "--cap-add SYS_CHROOT",
        "--security-opt no-new-privileges",
        "--security-opt seccomp=packaging/desktop/seccomp.json",
      ]) {
        expect(command).toContain(flag);
      }
    }
  }
});

test("the update command installs the new client without a code", () => {
  expect(agentumInstallCommand(ORIGIN)).toBe(
    `curl -fsSL ${ORIGIN}/install-agentum.sh | sh`
  );
});
