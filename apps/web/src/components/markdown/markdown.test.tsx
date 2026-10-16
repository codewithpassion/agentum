import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./markdown.tsx";

test("bold text renders as strong", () => {
  expect(renderToStaticMarkup(<Markdown>{"**a**"}</Markdown>)).toContain(
    "<strong>a</strong>"
  );
});

test("raw script tags are dropped", () => {
  const html = renderToStaticMarkup(
    <Markdown>{"<script>alert(1)</script>"}</Markdown>
  );
  expect(html).not.toContain("<script");
});

test("links open in a new tab without opener access", () => {
  const html = renderToStaticMarkup(
    <Markdown>{"[x](https://e.com)"}</Markdown>
  );
  expect(html).toContain('target="_blank"');
  expect(html).toContain('rel="noopener noreferrer"');
  expect(html).toContain('href="https://e.com"');
});

test("javascript: links lose their href", () => {
  const html = renderToStaticMarkup(
    <Markdown>{"[x](javascript:alert(1))"}</Markdown>
  );
  expect(html).not.toContain("javascript:");
});

test("a dash list renders list items", () => {
  const html = renderToStaticMarkup(<Markdown>{"- a\n- b"}</Markdown>);
  expect(html).toContain("<li>a</li>");
  expect(html).toContain("<li>b</li>");
});
