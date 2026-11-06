import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const AUTOMATIC_TRIGGER = /^ {2}(push|pull_request|schedule):/m;
const root = resolve(import.meta.dir, "../../../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

test("Rust desktop ships the Chromium seccomp profile and documents all run flags", () => {
  expect(
    JSON.parse(read("apps/agentum/packaging/desktop/seccomp.json"))
  ).toEqual(JSON.parse(read("apps/computer/packaging/desktop/seccomp.json")));
  const docs = read("apps/agentum/README.md");
  for (const flag of [
    "AGENTUM_ENROLL_CODE",
    "--shm-size=256m",
    "--cap-drop ALL",
    "--cap-add SYS_CHROOT",
    "--security-opt no-new-privileges",
    "--security-opt seccomp=packaging/desktop/seccomp.json",
  ]) {
    expect(docs).toContain(flag);
  }
});
test("manual image workflow builds both Rust targets before publishing both variants", () => {
  const workflow = read(".github/workflows/computer.yml");
  expect(workflow).toContain("workflow_dispatch:");
  expect(workflow).not.toMatch(AUTOMATIC_TRIGGER);
  expect(workflow).toContain("apps/agentum/scripts/build-all.sh");
  expect(workflow).toContain("apps/agentum/Dockerfile.desktop");
  expect(workflow).toContain("apps/agentum/Dockerfile");
  expect(workflow).toContain("platforms: linux/amd64,linux/arm64");
  expect(workflow).toContain("/agentum:latest");
  expect(workflow).toContain("/agentum:desktop");
});
