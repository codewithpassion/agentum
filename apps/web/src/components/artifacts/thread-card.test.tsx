import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  artifactThumbnailSrc,
  artifactViewerHref,
  THREAD_PREVIEW_HEIGHT_PX,
  type ThreadCardArtifact,
  ThreadCardView,
  threadCardArtifactOf,
} from "./thread-card.tsx";

const noop = () => undefined;
const artifact: ThreadCardArtifact = {
  artifactId: "3f0c8a7e-6b1d-4c2a-9e5f-1a2b3c4d5e6f",
  kind: "dashboard",
  title: "Q4 plan",
  version: 3,
};
const preview = {
  contentUrl: "/a/3f0c8a7e/c/tok/",
  createdAt: "2026-10-27T00:00:00.000Z",
  number: 3,
};

const render = (
  variant: "desktop" | "phone",
  overrides: { interactive?: boolean; withPreview?: boolean } = {}
) =>
  renderToStaticMarkup(
    <ThreadCardView
      artifact={artifact}
      interactive={overrides.interactive ?? false}
      onInteract={noop}
      onLeave={noop}
      preview={overrides.withPreview === false ? null : preview}
      variant={variant}
    />
  );

test("threadCardArtifactOf reads a data-artifact part and rejects other data", () => {
  expect(threadCardArtifactOf({ ...artifact, versionId: "v3" })).toEqual(
    artifact
  );
  expect(threadCardArtifactOf(null)).toBeNull();
  expect(threadCardArtifactOf({ ...artifact, kind: "video" })).toBeNull();
  expect(threadCardArtifactOf({ ...artifact, version: "3" })).toBeNull();
  expect(threadCardArtifactOf({ title: "x" })).toBeNull();
});

test("the desktop card shows title, v<n>, Open and a 360 px preview with the interact overlay", () => {
  const html = render("desktop");
  expect(html).toContain("Q4 plan");
  expect(html).toContain("v3");
  expect(html).toContain(`href="${artifactViewerHref(artifact.artifactId)}"`);
  expect(html).toContain('data-kind="dashboard"');
  expect(html).toContain('data-testid="thread-card-preview"');
  expect(html).toContain(`height:${THREAD_PREVIEW_HEIGHT_PX}px`);
  expect(THREAD_PREVIEW_HEIGHT_PX).toBe(360);
  expect(html).toContain('data-testid="thread-card-overlay"');
  expect(html).not.toContain("<img");
});

test("the desktop card drops the overlay once interactive, and waits for the content URL", () => {
  expect(render("desktop", { interactive: true })).not.toContain(
    "thread-card-overlay"
  );
  expect(render("desktop", { withPreview: false })).toContain(
    'data-testid="thread-card-preview"'
  );
});

test("the phone card shows the thumbnail and Open, with no preview or overlay", () => {
  const html = render("phone");
  expect(html).toContain('data-variant="phone"');
  expect(html).toContain(`src="${artifactThumbnailSrc(artifact)}"`);
  expect(html).toContain(`href="${artifactViewerHref(artifact.artifactId)}"`);
  expect(html).not.toContain("thread-card-preview");
  expect(html).not.toContain("thread-card-overlay");
});
