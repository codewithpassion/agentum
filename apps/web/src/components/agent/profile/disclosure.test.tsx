import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Disclosure } from "./disclosure.tsx";

test("a closed disclosure shows its title and hides its content", () => {
  const html = renderToStaticMarkup(
    <Disclosure title="More">
      <span>hidden-content</span>
    </Disclosure>
  );
  expect(html).toContain("More");
  expect(html).not.toContain("hidden-content");
});

test("a disclosure that starts open shows its content", () => {
  const html = renderToStaticMarkup(
    <Disclosure defaultOpen title="More">
      <span>shown-content</span>
    </Disclosure>
  );
  expect(html).toContain("shown-content");
});
