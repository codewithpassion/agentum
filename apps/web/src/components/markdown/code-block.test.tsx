import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./markdown.tsx";

test("code block has a language and Copy header, and scrolls inside its column", () => {
  const html = renderToStaticMarkup(
    <Markdown>{"```bash\ncurl https://example.com\n```"}</Markdown>
  );
  expect(html).toContain("bash");
  expect(html).toContain(">Copy</button>");
  expect(html).toContain("overflow-x-auto");
});
