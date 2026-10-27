import { describe, expect, it } from "bun:test";
import { renderDocPage } from "./doc.ts";

const page = (markdown: string, title?: string) =>
  renderDocPage(markdown, { bridgeSrc: "_hm/bridge.js", title });

const EXTERNAL_URL = /https?:\/\//;

describe("renderDocPage", () => {
  it("renders headings, paragraphs, lists and code", () => {
    const html = page("# Title\n\nSome *text*.\n\n- a\n- b\n\n```\ncode\n```");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<em>text</em>");
    expect(html).toContain("<li>a</li>");
    expect(html).toContain("<pre><code>code");
  });

  it("renders GitHub tables and strikethrough", () => {
    const html = page("| a | b |\n|---|---|\n| 1 | 2 |\n\n~~gone~~");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>2</td>");
    expect(html).toContain("<del>gone</del>");
  });

  it("starts with a doctype and the bridge script first in head", () => {
    const html = page("hi");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<head><script src="_hm/bridge.js"></script>');
  });

  it("drops raw html from the markdown", () => {
    const html = page("before <script>alert(1)</script> after");
    expect(html).not.toContain("alert(1)</script>");
    expect(html.match(/<script/g)?.length).toBe(1);
  });

  it("strips javascript: links", () => {
    const html = page("[x](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
  });

  it("escapes the title and the bridge src", () => {
    const html = renderDocPage("x", {
      bridgeSrc: '"><img onerror=x>',
      title: "<img onerror=x> & 'q'",
    });
    expect(html).not.toContain("<img onerror=x>");
    expect(html).toContain("&lt;img onerror=x&gt; &amp; &#39;q&#39;");
    expect(html).toContain('src="&quot;&gt;&lt;img onerror=x&gt;"');
  });

  it("uses no external resources", () => {
    expect(page("hi")).not.toMatch(EXTERNAL_URL);
  });
});
