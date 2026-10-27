import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ThreadAuthor } from "./thread-author.tsx";

test("author presentation hides single-person labels and escapes names", () => {
  expect(renderToStaticMarkup(<ThreadAuthor label={undefined} />)).toBe("");
  const html = renderToStaticMarkup(<ThreadAuthor label="<b>Alex</b> · 2" />);
  expect(html).toContain('data-testid="message-author"');
  expect(html).toContain("&lt;b&gt;Alex&lt;/b&gt; · 2");
  expect(html).not.toContain("<b>");
});
