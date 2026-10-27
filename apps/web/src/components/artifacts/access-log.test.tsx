import { expect, test } from "bun:test";
import type { ArtifactShare, ArtifactView } from "@repo/protocol/artifacts";
import { renderToStaticMarkup } from "react-dom/server";
import { AccessLogTable } from "./access-log.tsx";

const ARTIFACT_ID = "7f1d6f0e-3c43-4a4e-9f6b-2b6a1a1c0001";

const view = (overrides: Partial<ArtifactView> = {}): ArtifactView => ({
  artifactId: ARTIFACT_ID,
  asn: "1221",
  asOrg: "Telstra",
  city: "Sydney",
  country: "AU",
  createdAt: "2026-10-27T09:00:00.000Z",
  id: "view_1",
  ipPrefix: "203.0.113.0/24",
  outcome: "ok",
  referrerHost: null,
  region: "NSW",
  shareId: "share_1",
  surface: "share",
  toolKey: null,
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  userId: null,
  versionId: null,
  ...overrides,
});

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
  openCount: 1,
  revokedAt: null,
  status: "active",
  url: "https://example.com/s/x",
  versionId: null,
  ...overrides,
});

test("an empty log says so", () => {
  const html = renderToStaticMarkup(<AccessLogTable shares={[]} views={[]} />);
  expect(html).toContain("No opens yet.");
  expect(html).not.toContain("<table");
});

test("a row shows who, place, network, browser and outcome", () => {
  const html = renderToStaticMarkup(
    <AccessLogTable shares={[share()]} views={[view()]} />
  );
  expect(html).toContain("Link created ");
  expect(html).toContain("Sydney, NSW, AU");
  expect(html).toContain("Telstra (203.0.113.0/24)");
  expect(html).toContain("Chrome on macOS");
  expect(html).toContain("Opened");
});

test("cells carry labels for the stacked phone rows", () => {
  const html = renderToStaticMarkup(
    <AccessLogTable shares={[share()]} views={[view()]} />
  );
  for (const label of [
    "Time",
    "Who",
    "Place",
    "Network",
    "Browser",
    "Outcome",
  ]) {
    expect(html).toContain(`data-label="${label}"`);
  }
});

test("an open of a revoked link shows its outcome", () => {
  const html = renderToStaticMarkup(
    <AccessLogTable
      shares={[share({ status: "revoked" })]}
      views={[view({ id: "view_2", outcome: "revoked" })]}
    />
  );
  expect(html).toContain("Link revoked");
});

test("one row per view", () => {
  const html = renderToStaticMarkup(
    <AccessLogTable
      shares={[share()]}
      views={[view({ id: "a" }), view({ id: "b" }), view({ id: "c" })]}
    />
  );
  expect(html.match(/data-label="Time"/g)).toHaveLength(3);
});
