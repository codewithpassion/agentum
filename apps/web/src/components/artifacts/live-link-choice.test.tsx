import { expect, test } from "bun:test";
import type { ArtifactShare } from "@repo/protocol/artifacts";
import { renderToStaticMarkup } from "react-dom/server";
import { CreateLinkForm } from "./create-link-form.tsx";
import { LinkList } from "./link-list.tsx";
import { LiveLinkChoice } from "./live-link-choice.tsx";

const noop = () => undefined;
const WARNING =
  "Anyone with this link can run these tools as you until it expires or you revoke it. Every call is logged.";
const CHECKED_CHECKBOX = /<input[^>]*type="checkbox"[^>]*checked=""/;
const SNAPSHOT_RADIO = /checked=""\/>Snapshot only/;

const choice = (mode: "live" | "snapshot", options: string[]) =>
  renderToStaticMarkup(
    <LiveLinkChoice
      expiryText="This link expires in 7 days."
      groupName="g"
      mode={mode}
      onModeChange={noop}
      onToggle={noop}
      options={options}
      ticked={[]}
    />
  );

test("snapshot is the default: radio checked, no tools, no warning", () => {
  const html = choice("snapshot", ["gmail.search"]);
  expect(html).toContain("Data");
  expect(SNAPSHOT_RADIO.test(html)).toBe(true);
  expect(html).not.toContain('type="checkbox"');
  expect(html).not.toContain(WARNING);
});

test("live shows unticked tool boxes, the warning and the expiry", () => {
  const html = choice("live", ["gmail.search", "drive.list"]);
  expect(html.match(/type="checkbox"/g)?.length).toBe(2);
  expect(CHECKED_CHECKBOX.test(html)).toBe(false);
  expect(html).toContain(WARNING);
  expect(html).toContain("This link expires in 7 days.");
});

test("live with no tools says so and shows no checkbox", () => {
  const html = choice("live", []);
  expect(html).toContain(
    "This version has no approved read-only tools to share."
  );
  expect(html).not.toContain('type="checkbox"');
});

test("CreateLinkForm hides the Data choice without canCreateLive", () => {
  const props = {
    artifactId: "a1",
    currentVersionId: "v1",
    liveToolOptions: ["x"],
    onCreated: noop,
  };
  expect(
    renderToStaticMarkup(<CreateLinkForm {...props} canCreateLive={false} />)
  ).not.toContain("Snapshot only");
  const html = renderToStaticMarkup(
    <CreateLinkForm {...props} canCreateLive />
  );
  expect(html).toContain("Snapshot only");
  expect(html).toContain("Live, using my connections");
  expect(html).not.toContain(WARNING);
});

const live: ArtifactShare = {
  artifactId: "a1",
  createdAt: "2026-10-01T10:00:00.000Z",
  createdBy: "user_1",
  dataMode: "live",
  expiresAt: null,
  grantedBy: null,
  id: "s1",
  lastOpenedAt: null,
  liveTools: ["gmail.search", "gmail.search#{}"],
  openCount: 0,
  revokedAt: null,
  status: "active",
  url: "https://example.test/s/abc",
  versionId: null,
};

const list = (share: ArtifactShare, ownerName: string | null) =>
  renderToStaticMarkup(
    <LinkList
      canManage
      onChanged={noop}
      ownerName={ownerName}
      shares={[share]}
      versionNumbers={new Map()}
    />
  );

test("LinkList badges a live share and lists its tools without limit rows", () => {
  const html = list(live, "Ada");
  expect(html).toContain("Live as Ada");
  expect(html).toContain("gmail.search");
  expect(html).not.toContain("#{}");
  expect(list(live, null)).toContain("Live as the owner");
  expect(html).toContain(">Copy<");
});

test("LinkList hides Copy for a token-less url but keeps Revoke", () => {
  const html = list({ ...live, url: "https://example.test/s/" }, "Ada");
  expect(html).not.toContain(">Copy<");
  expect(html).toContain(">Revoke<");
});
