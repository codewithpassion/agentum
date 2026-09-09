import { describe, expect, test } from "bun:test";
import { MAX_ALLOWED_HOSTS } from "#/modules/secrets/hosts";
import {
  SECRET_VALUE_MAX_LENGTH as SERVER_VALUE_MAX,
  SECRET_VALUE_MIN_LENGTH as SERVER_VALUE_MIN,
} from "#/modules/secrets/service";
import type { Secret } from "./api";
import {
  addHostChip,
  hintLabel,
  hostChipFrom,
  hostsLabel,
  lastUsedLabel,
  SECRET_VALUE_MAX_LENGTH,
  SECRET_VALUE_MIN_LENGTH,
  secretDotStatus,
  secretSummary,
} from "./secrets-format";

const secret = (overrides: Partial<Secret> = {}): Secret => ({
  agentIds: [],
  allowedHosts: ["api.deepgram.com"],
  createdAt: "2026-09-01T12:00:00.000Z",
  description: "",
  header: "Authorization",
  headerPrefix: "Token ",
  hint: "9f2c",
  id: "sec_1",
  lastUsedAt: null,
  name: "DEEPGRAM_API_KEY",
  syncError: null,
  syncStatus: "synced",
  updatedAt: "2026-09-01T12:00:00.000Z",
  ...overrides,
});

test("the hint is shown as an elision, never as a whole value", () => {
  expect(hintLabel("9f2c")).toBe("…9f2c");
});

describe("lastUsedLabel", () => {
  const now = Date.parse("2026-09-10T12:00:00.000Z");

  test("says so when a secret has never been used", () => {
    expect(lastUsedLabel(null, now)).toBe("never used");
  });

  test("reads an ISO string as a relative time", () => {
    expect(lastUsedLabel("2026-09-10T09:00:00.000Z", now)).toBe("used 3h ago");
  });
});

describe("hostsLabel", () => {
  test("an empty allowlist means nowhere, and says nowhere", () => {
    expect(hostsLabel([])).toBe("no hosts");
  });

  test("lists what was allowed", () => {
    expect(hostsLabel(["api.deepgram.com", "*.example.com"])).toBe(
      "api.deepgram.com, *.example.com"
    );
  });
});

describe("hostChipFrom", () => {
  test("takes the host out of a pasted URL", () => {
    expect(hostChipFrom("https://api.deepgram.com/v1/listen")).toBe(
      "api.deepgram.com"
    );
  });

  test("lowercases and trims", () => {
    expect(hostChipFrom("  API.Deepgram.COM ")).toBe("api.deepgram.com");
  });

  test("keeps a wildcard", () => {
    expect(hostChipFrom("*.deepgram.com")).toBe("*.deepgram.com");
  });

  test("leaves a port alone, so the server can refuse it by name", () => {
    expect(hostChipFrom("api.deepgram.com:8443")).toBe("api.deepgram.com:8443");
  });
});

describe("addHostChip", () => {
  test("normalizes before adding", () => {
    expect(addHostChip([], "https://api.deepgram.com/v1")).toEqual([
      "api.deepgram.com",
    ]);
  });

  test("does not add the same host twice", () => {
    expect(addHostChip(["api.deepgram.com"], "API.deepgram.com")).toEqual([
      "api.deepgram.com",
    ]);
  });

  test("ignores an empty entry", () => {
    expect(addHostChip(["api.deepgram.com"], "   ")).toEqual([
      "api.deepgram.com",
    ]);
  });
});

describe("secretDotStatus", () => {
  test("an unregistered mirror reads as not synced yet", () => {
    expect(secretDotStatus("unregistered")).toBe("unsynced");
  });

  test("the other two states are the dot's own", () => {
    expect(secretDotStatus("synced")).toBe("synced");
    expect(secretDotStatus("error")).toBe("error");
  });
});

describe("secretSummary", () => {
  const now = Date.parse("2026-09-10T12:00:00.000Z");

  test("names the secret, its hosts and its last use - never its value", () => {
    expect(
      secretSummary(secret({ lastUsedAt: "2026-09-10T11:30:00.000Z" }), now)
    ).toBe("DEEPGRAM_API_KEY …9f2c · api.deepgram.com · used 30m ago");
  });
});

describe("the value limits the form enforces", () => {
  test("are the server's own, so a paste is refused for the right reason", () => {
    expect(SECRET_VALUE_MIN_LENGTH).toBe(SERVER_VALUE_MIN);
    expect(SECRET_VALUE_MAX_LENGTH).toBe(SERVER_VALUE_MAX);
  });

  test("the host cap comes straight from the allowlist rules", () => {
    expect(MAX_ALLOWED_HOSTS).toBe(16);
  });
});
