import { describe, expect, test } from "bun:test";
import type { ComputerHost } from "./api";
import {
  COMPUTERD_IMAGE,
  computerdRunCommand,
  computerSummary,
  hostChoicesFor,
  hostRemovalBlock,
  lastSeenLabel,
} from "./computer-hosts";

const host = (overrides: Partial<ComputerHost> = {}): ComputerHost => ({
  agentIds: [],
  config: {},
  createdAt: "2026-08-20T12:00:00.000Z",
  flyApiTokenHint: null,
  id: "cmh_1",
  kind: "self_hosted",
  lastSeenAt: null,
  name: "office-box",
  status: "unconfigured",
  statusError: null,
  ...overrides,
});

describe("computerdRunCommand", () => {
  const input = { token: "tok_abc", url: "https://agentum.example.com" };

  test("carries the volume, the caps and the token", () => {
    const command = computerdRunCommand("docker", input);
    expect(command).toStartWith("docker run -d --name agentum-computer");
    expect(command).toContain("--restart unless-stopped");
    expect(command).toContain("--memory 2g --cpus 2");
    expect(command).toContain("-v agentum-computer:/home/agent");
    expect(command).toContain("-e AGENTUM_URL=https://agentum.example.com");
    expect(command).toContain("-e AGENTUM_COMPUTER_TOKEN=tok_abc");
    expect(command).toEndWith(COMPUTERD_IMAGE);
  });

  test("adds the rootless volume-ownership flag for podman only", () => {
    expect(computerdRunCommand("podman", input)).toContain("--userns=keep-id");
    expect(computerdRunCommand("docker", input)).not.toContain("--userns");
  });
});

describe("lastSeenLabel", () => {
  test("says so when nothing has ever connected", () => {
    expect(lastSeenLabel(null)).toBe("never seen");
  });

  test("counts back from an ISO timestamp", () => {
    const now = Date.UTC(2026, 7, 20, 12, 0, 0);
    expect(lastSeenLabel(new Date(now - 3 * 60_000).toISOString(), now)).toBe(
      "3m ago"
    );
  });
});

describe("hostChoicesFor", () => {
  const hosts = [
    host({ id: "cmh_free" }),
    host({ agentIds: ["agt_1"], id: "cmh_taken" }),
    host({ id: "cmh_fly", kind: "fly" }),
  ];

  test("keeps only the hosts of that kind", () => {
    expect(hostChoicesFor(hosts, "fly").map((c) => c.host.id)).toEqual([
      "cmh_fly",
    ]);
  });

  test("marks a self-hosted host that already has an agent", () => {
    const choices = hostChoicesFor(hosts, "self_hosted");
    expect(choices.map((choice) => choice.disabledReason)).toEqual([
      null,
      "in use",
    ]);
  });

  test("leaves a Fly host with agents pickable - its app holds many", () => {
    const busy = [host({ agentIds: ["agt_1"], id: "cmh_fly", kind: "fly" })];
    expect(hostChoicesFor(busy, "fly")[0]?.disabledReason).toBeNull();
  });
});

describe("hostRemovalBlock", () => {
  test("nothing blocks an empty host", () => {
    expect(hostRemovalBlock(host())).toBeNull();
  });

  test("counts the agents that would be stranded", () => {
    expect(hostRemovalBlock(host({ agentIds: ["a"] }))).toBe(
      "This host still runs 1 agent. Delete it first."
    );
    expect(hostRemovalBlock(host({ agentIds: ["a", "b"] }))).toBe(
      "This host still runs 2 agents. Delete them first."
    );
  });
});

describe("computerSummary", () => {
  test("names the backend, and the host when there is one", () => {
    expect(computerSummary("cloudflare", null)).toBe("Cloudflare");
    expect(computerSummary("fly", "prod-app")).toBe("Fly · prod-app");
    expect(computerSummary("self_hosted", "office-box")).toBe(
      "office-box (self-hosted)"
    );
  });

  test("falls back to the backend alone when the host is not loaded", () => {
    expect(computerSummary("fly", null)).toBe("Fly");
    expect(computerSummary("self_hosted", null)).toBe("self-hosted");
  });
});
