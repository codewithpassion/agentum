import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ArtifactTabs,
  orderedSourceFiles,
  SourceFiles,
  SourcePreview,
} from "./source.tsx";

const noop = () => undefined;

const files = [
  { contentType: "text/plain", path: "z.txt", size: 5 },
  { contentType: "text/javascript", path: "server/z.js", size: 8 },
  { contentType: "image/png", path: "a.png", size: 3 },
  { contentType: "text/javascript", path: "server/a.js", size: 4 },
  { contentType: "text/html", path: "index.html", size: 10 },
] as const;

test("source lists entry, server files, then the rest by path with size and type", () => {
  const ordered = orderedSourceFiles(files, "index.html");
  expect(ordered.map((file) => file.path)).toEqual([
    "index.html",
    "server/a.js",
    "server/z.js",
    "a.png",
    "z.txt",
  ]);
  const html = renderToStaticMarkup(
    <SourceFiles files={ordered} onSelect={noop} selected="index.html" />
  );
  expect(html).toContain("image/png");
  expect(html).toContain("3 bytes");
  expect(html).toContain('aria-pressed="true"');
});

test("source renders escaped read-only text with line numbers and truncation notice", () => {
  const html = renderToStaticMarkup(
    <SourcePreview
      file={files[4]}
      read={{
        ...files[4],
        text: "<h1>Hi</h1>\nnext",
        truncated: true,
        version: 1,
      }}
    />
  );
  expect(html).toContain("&lt;h1&gt;Hi&lt;/h1&gt;");
  expect(html).toContain('data-line="2"');
  expect(html).toContain("512 KB");
  expect(html).not.toContain("textarea");
});

test("binary files show metadata and a Download note", () => {
  const html = renderToStaticMarkup(<SourcePreview file={files[2]} />);
  expect(html).toContain("image/png");
  expect(html).toContain("3 bytes");
  expect(html).toContain("Download");
});

test("readers see Source while Access log stays with managers", () => {
  const html = renderToStaticMarkup(
    <ArtifactTabs
      canManage={false}
      kind="app"
      onValueChange={noop}
      value="source"
    />
  );
  expect(html).toContain("Source");
  expect(html).toContain("Artifact");
  expect(html).not.toContain("Access log");
  expect(html).not.toContain("Calls");
  const managed = renderToStaticMarkup(
    <ArtifactTabs canManage kind="app" onValueChange={noop} value="artifact" />
  );
  expect(managed).toContain("Access log");
  expect(managed).toContain("Calls");
  expect(
    renderToStaticMarkup(
      <ArtifactTabs
        canManage
        kind="page"
        onValueChange={noop}
        value="artifact"
      />
    )
  ).not.toContain("Calls");
});
