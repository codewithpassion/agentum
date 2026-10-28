import { expect, test } from "bun:test";
import { DECK_STALE_ANCESTRY } from "@repo/protocol/deck";
import { renderToStaticMarkup } from "react-dom/server";
import { DeckRefusalNotice, isStaleAncestry } from "./deck-refusal-notice.tsx";

const noop = () => undefined;

test("tells the editor their offline changes were refused and offers a reload", () => {
  const html = renderToStaticMarkup(<DeckRefusalNotice onReload={noop} />);
  expect(html).toContain("offline changes couldn&#x27;t be applied");
  expect(html).toContain("Reload to continue");
  expect(html).toContain(">Reload deck</button>");
  expect(html).toContain('role="alert"');
});

test("only the typed refusal selects the notice", () => {
  expect(isStaleAncestry(DECK_STALE_ANCESTRY)).toBe(true);
  expect(isStaleAncestry("Room disconnected")).toBe(false);
  expect(isStaleAncestry(undefined)).toBe(false);
});
