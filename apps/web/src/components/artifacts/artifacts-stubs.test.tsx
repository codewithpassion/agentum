import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AccessLog } from "./access-log.tsx";
import { ArtifactFrame } from "./artifact-frame.tsx";
import { ShareDialog } from "./share-dialog.tsx";

const noop = () => undefined;

test("ArtifactFrame renders the placeholder with title and version, and no iframe", () => {
  const html = renderToStaticMarkup(
    <ArtifactFrame
      contentUrl="/content/a1"
      interactive={false}
      title="Quarterly plan"
      version={{ createdAt: "2026-10-27T00:00:00Z", number: 3 }}
      viewer="member"
    />
  );
  expect(html).toContain('data-testid="artifact-frame"');
  expect(html).toContain("Artifact frame placeholder: Quarterly plan v3");
  expect(html).not.toContain("<iframe");
});

test("ShareDialog renders nothing when closed", () => {
  const html = renderToStaticMarkup(
    <ShareDialog artifactId="a1" onOpenChange={noop} open={false} />
  );
  expect(html).toBe("");
});

test("ShareDialog renders a dialog placeholder when open", () => {
  const html = renderToStaticMarkup(
    <ShareDialog artifactId="a1" onOpenChange={noop} open />
  );
  expect(html).toContain('role="dialog"');
  expect(html).toContain('data-testid="share-dialog"');
});

test("AccessLog renders the placeholder with the artifact id", () => {
  const html = renderToStaticMarkup(<AccessLog artifactId="a1" />);
  expect(html).toContain('data-testid="access-log"');
  expect(html).toContain("Access log placeholder: a1");
});
