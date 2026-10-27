import { expect, test } from "bun:test";
import { documentContent } from "./content";

test("checkpoint codec round trips rich markdown without a DOM and escapes text", async () => {
  const codec = documentContent();
  const snapshot = await codec.importMarkdown(
    "# Hello\n\n**Bold** & text\n\n- [x] Done\n\n| A | B |\n|---|---|\n| c | d |\n\n<script>alert(1)</script>"
  );
  const rendered = await codec.exportDocument(
    await codec.loadDocument(snapshot.state)
  );
  expect(rendered.html).toContain("<h1>Hello</h1>");
  expect(rendered.html).toContain("<strong>Bold</strong> &amp; text");
  expect(rendered.html).toContain("<table>");
  expect(rendered.html).not.toContain("<script");
  expect(rendered.markdown).toContain("Hello");
});
