import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ArtifactFrame } from "./artifact-frame.tsx";

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
