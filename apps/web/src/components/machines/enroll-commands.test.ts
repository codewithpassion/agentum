import { describe, expect, test } from "bun:test";
import {
  binaryCommand,
  DESKTOP_IMAGE,
  DESKTOP_SECCOMP_NOTE,
  daemonCommand,
  dockerDesktopCommand,
  dockerHeadlessCommand,
  HEADLESS_IMAGE,
  IMAGE_OWNER,
} from "./enroll-commands";

const ORIGIN = "https://hm.example.test";
const CODE = "hm_enr_abc123";

describe("image names", () => {
  test("are built from the image owner", () => {
    expect(HEADLESS_IMAGE).toBe(
      `ghcr.io/${IMAGE_OWNER}/harbourmaster-computer:latest`
    );
    expect(DESKTOP_IMAGE).toBe(
      `ghcr.io/${IMAGE_OWNER}/harbourmaster-computer-desktop:latest`
    );
  });
});

describe("daemonCommand", () => {
  test("enrols with the code and server origin", () => {
    expect(daemonCommand(ORIGIN, CODE)).toBe(
      `harbourmaster enroll ${CODE} --server ${ORIGIN}`
    );
  });
});

describe("dockerHeadlessCommand", () => {
  const command = dockerHeadlessCommand(ORIGIN, CODE);

  test("runs the headless image with the origin and code", () => {
    expect(command).toContain(HEADLESS_IMAGE);
    expect(command).toContain(`--url ${ORIGIN} --code ${CODE}`);
    expect(command).toContain("--name hm-computer");
    expect(command).toContain("-v hm-computer:/var/lib/hm-computer");
  });

  test("has no seccomp flag and no desktop image", () => {
    expect(command).not.toContain("seccomp");
    expect(command).not.toContain(DESKTOP_IMAGE);
  });

  test("continues lines with a backslash", () => {
    const lines = command.split("\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines.slice(0, -1)) {
      expect(line.endsWith(" \\")).toBe(true);
    }
  });
});

describe("dockerDesktopCommand", () => {
  const command = dockerDesktopCommand(ORIGIN, CODE);

  test("runs the desktop image with the origin and code", () => {
    expect(command).toContain(DESKTOP_IMAGE);
    expect(command).toContain(`--url ${ORIGIN} --code ${CODE}`);
    expect(command).toContain("-v hm-computer-desktop:/var/lib/hm-computer");
  });

  test("keeps the hardening flags and the seccomp profile", () => {
    expect(command).toContain("--shm-size=256m");
    expect(command).toContain("--cap-drop ALL");
    expect(command).toContain("--cap-add SYS_CHROOT");
    expect(command).toContain("--security-opt no-new-privileges");
    expect(command).toContain(
      "--security-opt seccomp=packaging/desktop/seccomp.json"
    );
  });

  test("uses no headless image", () => {
    expect(command).not.toContain(HEADLESS_IMAGE);
  });
});

describe("binaryCommand", () => {
  test("runs the binary with the origin and code and no desktop flag", () => {
    const command = binaryCommand(ORIGIN, CODE);
    expect(command).toBe(`hm-computer run --url ${ORIGIN} --code ${CODE}`);
    expect(command).not.toContain("--desktop");
  });
});

describe("DESKTOP_SECCOMP_NOTE", () => {
  test("names the seccomp profile path", () => {
    expect(DESKTOP_SECCOMP_NOTE).toContain("packaging/desktop/seccomp.json");
    expect(DESKTOP_SECCOMP_NOTE).toContain("apps/computer");
  });
});
