import { expect, test } from "bun:test";
import type { ArtifactShare } from "@repo/protocol/artifacts";
import { renderToStaticMarkup } from "react-dom/server";
import { CreateLinkForm } from "./create-link-form.tsx";
import { LinkList } from "./link-list.tsx";
import { ShareDialog } from "./share-dialog.tsx";

const noop = () => undefined;

const share = (overrides: Partial<ArtifactShare>): ArtifactShare => ({
  artifactId: "a1",
  createdAt: "2026-10-01T10:00:00.000Z",
  createdBy: "user_1",
  dataMode: "snapshot",
  expiresAt: null,
  grantedBy: null,
  id: "s1",
  lastOpenedAt: null,
  liveTools: null,
  openCount: 0,
  revokedAt: null,
  status: "active",
  url: "https://example.test/s/abc",
  versionId: null,
  ...overrides,
});

test("CreateLinkForm lists the expiry options in order with both version choices", () => {
  const html = renderToStaticMarkup(
    <CreateLinkForm
      artifactId="a1"
      currentVersionId="v1"
      currentVersionNumber={3}
      onCreated={noop}
    />
  );
  const labels = ["Never", "1 day", "7 days", "30 days", "A date"];
  const positions = labels.map((label) => html.indexOf(`>${label}</option>`));
  expect(positions.every((p) => p >= 0)).toBe(true);
  expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  expect(html).toContain("Follow latest version");
  expect(html).toContain("Pin this version (v3)");
  expect(html).toContain("Create link");
  expect(html).not.toContain('type="date"');
});

test("LinkList shows Copy, Revoke and the counts for an active share", () => {
  const html = renderToStaticMarkup(
    <LinkList
      onChanged={noop}
      shares={[share({ openCount: 12 })]}
      versionNumbers={new Map()}
    />
  );
  expect(html).toContain("Copy");
  expect(html).toContain("Revoke");
  expect(html).toContain(">12<");
  expect(html).toContain("Follows latest");
  expect(html).toContain("Never");
});

test("LinkList shows neither Copy nor Revoke for a revoked share", () => {
  const html = renderToStaticMarkup(
    <LinkList
      onChanged={noop}
      shares={[
        share({ revokedAt: "2026-10-02T10:00:00.000Z", status: "revoked" }),
      ]}
      versionNumbers={new Map()}
    />
  );
  expect(html).toContain("Revoked");
  expect(html).not.toContain("Copy");
  expect(html).not.toContain(">Revoke<");
});

test("LinkList lists the newest link first", () => {
  const html = renderToStaticMarkup(
    <LinkList
      onChanged={noop}
      shares={[
        share({
          createdAt: "2026-09-01T00:00:00.000Z",
          createdBy: "older",
          id: "s1",
        }),
        share({
          createdAt: "2026-10-01T00:00:00.000Z",
          createdBy: "newer",
          id: "s2",
        }),
      ]}
      versionNumbers={new Map()}
    />
  );
  expect(html.indexOf("newer")).toBeLessThan(html.indexOf("older"));
});

test("ShareDialog renders nothing when closed", () => {
  expect(
    renderToStaticMarkup(
      <ShareDialog artifactId="a1" onOpenChange={noop} open={false} />
    )
  ).toBe("");
});
