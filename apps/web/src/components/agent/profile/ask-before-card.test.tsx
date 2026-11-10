import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { OutsideEmailRow } from "./ask-before-card.tsx";

const BADGE = /<span class="([^"]*)">Always<\/span>/;

test("the Always badge never shrinks or wraps, at any width", () => {
  const html = renderToStaticMarkup(<OutsideEmailRow />);
  const badge = html.match(BADGE);
  expect(badge).not.toBeNull();
  const classes = (badge?.[1] ?? "").split(" ");
  expect(classes).toContain("shrink-0");
  expect(classes).toContain("whitespace-nowrap");
  expect(classes.some((c) => c.includes("max-md"))).toBe(false);
});
