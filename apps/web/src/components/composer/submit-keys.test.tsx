import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SubmitKeys } from "./submit-keys.tsx";

test("the indicator says Ctrl on first render, hides from screen readers and on phones", () => {
  const html = renderToStaticMarkup(<SubmitKeys />);
  expect(html).toContain("Ctrl ↵");
  expect(html).toContain('aria-hidden="true"');
  expect(html).toContain("max-sm:hidden");
  expect(html).toContain("pointer-coarse:hidden");
});
