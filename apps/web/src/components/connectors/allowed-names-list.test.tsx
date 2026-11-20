import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AllowedNamesList } from "./allowed-names-list.tsx";

const noop = () => undefined;
const LI_PATTERN = /<li\b/g;
const REMOVE_ALPHA_PATTERN =
  /<button\b[^>]*aria-label="Remove alpha"[^>]*>Remove<\/button>/;
const REMOVE_BETA_PATTERN =
  /<button\b[^>]*aria-label="Remove beta"[^>]*>Remove<\/button>/;
const DISABLED_REMOVE_PATTERN =
  /<button\b[^>]*disabled=""[^>]*>Remove<\/button>/;
const DISABLED_REMOVE_PATTERN_ALL =
  /<button\b[^>]*disabled=""[^>]*>Remove<\/button>/g;

test("AllowedNamesList renders each name once with a labelled Remove button", () => {
  const html = renderToStaticMarkup(
    <AllowedNamesList
      disabled={false}
      names={["alpha", "beta"]}
      onRemove={noop}
    />
  );
  expect(html.match(LI_PATTERN)?.length).toBe(2);
  expect(html.split(">alpha</span>").length - 1).toBe(1);
  expect(html.split(">beta</span>").length - 1).toBe(1);
  expect(html).toMatch(REMOVE_ALPHA_PATTERN);
  expect(html).toMatch(REMOVE_BETA_PATTERN);
});

test("AllowedNamesList disables every Remove button when disabled", () => {
  const html = renderToStaticMarkup(
    <AllowedNamesList disabled names={["alpha", "beta"]} onRemove={noop} />
  );
  expect(html.match(DISABLED_REMOVE_PATTERN_ALL)?.length).toBe(2);
});

test("AllowedNamesList leaves Remove buttons enabled when not disabled", () => {
  const html = renderToStaticMarkup(
    <AllowedNamesList disabled={false} names={["alpha"]} onRemove={noop} />
  );
  expect(html).not.toMatch(DISABLED_REMOVE_PATTERN);
});

test("AllowedNamesList renders no list items for an empty names array", () => {
  const html = renderToStaticMarkup(
    <AllowedNamesList disabled={false} names={[]} onRemove={noop} />
  );
  expect(html).not.toContain("<li");
});
