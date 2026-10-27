import { expect, test } from "bun:test";
import type { ArtifactShare } from "@repo/protocol/artifacts";
import {
  buildCreateShareInput,
  canToggleLinks,
  DEFAULT_EXPIRY,
  EXPIRY_CHOICES,
  EXPIRY_LABELS,
  resolveExpiry,
  revokeConfirmCopy,
  shareUrlHasToken,
  shareVersionLabel,
} from "./share-model.ts";

const now = new Date("2026-10-27T10:00:00.000Z");
const ARTIFACT_ID = "7f1d6f0e-3c43-4a4e-9f6b-2b6a1a1c0001";

const share = (overrides: Partial<ArtifactShare> = {}): ArtifactShare => ({
  artifactId: ARTIFACT_ID,
  createdAt: "2026-10-26T10:00:00.000Z",
  createdBy: "user_1",
  dataMode: "snapshot",
  expiresAt: null,
  grantedBy: null,
  id: "share_1",
  lastOpenedAt: null,
  liveTools: null,
  openCount: 0,
  revokedAt: null,
  status: "active",
  url: "https://example.com/s/hm_share_x",
  versionId: null,
  ...overrides,
});

test("the expiry choices are never, 1 day, 7 days, 30 days and a date", () => {
  expect(EXPIRY_CHOICES.map((choice) => EXPIRY_LABELS[choice])).toEqual([
    "Never",
    "1 day",
    "7 days",
    "30 days",
    "A date",
  ]);
  expect(DEFAULT_EXPIRY).toBe("7d");
});

test("never gives no expiry", () => {
  expect(resolveExpiry("never", "", now)).toEqual({
    expiresAt: null,
    ok: true,
  });
});

test("day choices add whole days to now", () => {
  expect(resolveExpiry("1d", "", now)).toEqual({
    expiresAt: "2026-10-28T10:00:00.000Z",
    ok: true,
  });
  expect(resolveExpiry("7d", "", now)).toEqual({
    expiresAt: "2026-11-03T10:00:00.000Z",
    ok: true,
  });
  expect(resolveExpiry("30d", "", now)).toEqual({
    expiresAt: "2026-11-26T10:00:00.000Z",
    ok: true,
  });
});

test("a date ends at the close of that day", () => {
  const result = resolveExpiry("date", "2026-12-24", now);
  expect(result.ok).toBe(true);
  const expiresAt = result.ok ? result.expiresAt : null;
  expect(expiresAt).not.toBeNull();
  if (expiresAt !== null) {
    const end = new Date(expiresAt);
    expect([end.getFullYear(), end.getMonth(), end.getDate()]).toEqual([
      2026, 11, 24,
    ]);
    expect([end.getHours(), end.getMinutes()]).toEqual([23, 59]);
  }
});

test("a date needs a value and must be in the future", () => {
  expect(resolveExpiry("date", "", now).ok).toBe(false);
  expect(resolveExpiry("date", "2026-10-20", now).ok).toBe(false);
  expect(resolveExpiry("date", "not-a-date", now).ok).toBe(false);
});

test("follow latest sends no version, pin sends the current version id", () => {
  const base = {
    artifactId: ARTIFACT_ID,
    currentVersionId: "ver_3",
    date: "",
    expiry: "7d" as const,
    now,
  };
  const follow = buildCreateShareInput({ ...base, pin: false });
  expect(follow.ok && follow.input.versionId).toBeNull();
  const pinned = buildCreateShareInput({ ...base, pin: true });
  expect(pinned.ok && pinned.input.versionId).toBe("ver_3");
});

test("the create input is a snapshot link with the resolved expiry", () => {
  const result = buildCreateShareInput({
    artifactId: ARTIFACT_ID,
    currentVersionId: "ver_3",
    date: "",
    expiry: "never",
    now,
    pin: false,
  });
  expect(result).toEqual({
    input: {
      artifactId: ARTIFACT_ID,
      dataMode: "snapshot",
      expiresAt: null,
      versionId: null,
    },
    ok: true,
  });
});

test("a bad date stops the create input", () => {
  const result = buildCreateShareInput({
    artifactId: ARTIFACT_ID,
    currentVersionId: "ver_3",
    date: "",
    expiry: "date",
    now,
    pin: false,
  });
  expect(result.ok).toBe(false);
});

test("the revoke confirmation names the consequence and the opens", () => {
  const copy = revokeConfirmCopy(share({ openCount: 3 }));
  expect(copy.title).toBe("Revoke this link?");
  expect(copy.confirmLabel).toBe("Revoke link");
  expect(copy.description).toContain("This link is not available.");
  expect(copy.description).toContain("3 times");
  expect(revokeConfirmCopy(share({ openCount: 1 })).description).toContain(
    "1 time."
  );
});

test("only an organisation admin can use the link switch", () => {
  expect(canToggleLinks("org:admin")).toBe(true);
  expect(canToggleLinks("org:member")).toBe(false);
  expect(canToggleLinks(null)).toBe(false);
  expect(canToggleLinks(undefined)).toBe(false);
});

test("a link's version label", () => {
  const numbers = new Map([["ver_3", 3]]);
  expect(shareVersionLabel(share(), numbers)).toBe("Follows latest");
  expect(shareVersionLabel(share({ versionId: "ver_3" }), numbers)).toBe(
    "Pinned to v3"
  );
  expect(shareVersionLabel(share({ versionId: "gone" }), numbers)).toBe(
    "Pinned"
  );
});

const liveBase = {
  artifactId: ARTIFACT_ID,
  currentVersionId: "ver-3",
  date: "",
  expiry: "7d" as const,
  now,
  pin: false,
};

test("buildCreateShareInput sends dataMode live with the ticked tools", () => {
  const built = buildCreateShareInput({
    ...liveBase,
    mode: "live",
    tools: ["gmail.search", "drive.list"],
  });
  expect(built.ok).toBe(true);
  if (built.ok) {
    expect(built.input.dataMode).toBe("live");
    expect(built.input.liveTools).toEqual(["gmail.search", "drive.list"]);
  }
});

test("buildCreateShareInput refuses a live link with no tools", () => {
  expect(
    buildCreateShareInput({ ...liveBase, mode: "live", tools: [] })
  ).toEqual({ error: "Pick at least one tool.", ok: false });
});

test("buildCreateShareInput sends no liveTools for a snapshot, even with tools passed", () => {
  const built = buildCreateShareInput({ ...liveBase, tools: ["a"] });
  expect(built.ok).toBe(true);
  if (built.ok) {
    expect(built.input.dataMode).toBe("snapshot");
    expect("liveTools" in built.input).toBe(false);
  }
});

test("shareUrlHasToken is false for the token-less member url", () => {
  expect(shareUrlHasToken("https://example.test/s/")).toBe(false);
  expect(shareUrlHasToken("https://example.test/s/abc")).toBe(true);
});
