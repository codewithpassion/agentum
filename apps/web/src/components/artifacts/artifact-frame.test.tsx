import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ArtifactFrame } from "./artifact-frame.tsx";

const html = renderToStaticMarkup(
  <ArtifactFrame
    contentUrl="/a/6f1c1d52-0c1e-4b7a-9d5e-2a3b4c5d6e7f/c/hm_view_x/"
    interactive
    title="Plan"
    version={{ createdAt: "2026-10-27T00:00:00.000Z", number: 1 }}
    viewer="member"
  />
);

test("the iframe carries exactly the sandbox, referrer policy and allow of R1.18", () => {
  expect(html).toContain('sandbox="allow-scripts allow-forms"');
  expect(html).toContain('referrerPolicy="no-referrer"');
  expect(html).toContain('allow="clipboard-write"');
  expect(html).not.toContain("allow-same-origin");
});
