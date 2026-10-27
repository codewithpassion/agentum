import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AccessLog } from "./access-log.tsx";
import { ShareDialog } from "./share-dialog.tsx";

const noop = () => undefined;

test("ShareDialog renders nothing when closed", () => {
  const html = renderToStaticMarkup(
    <ShareDialog artifactId="a1" onOpenChange={noop} open={false} />
  );
  expect(html).toBe("");
});

test("ShareDialog renders a dialog placeholder when open", () => {
  const html = renderToStaticMarkup(
    <ShareDialog artifactId="a1" onOpenChange={noop} open />
  );
  expect(html).toContain('role="dialog"');
  expect(html).toContain('data-testid="share-dialog"');
});

test("AccessLog renders the placeholder with the artifact id", () => {
  const html = renderToStaticMarkup(<AccessLog artifactId="a1" />);
  expect(html).toContain('data-testid="access-log"');
  expect(html).toContain("Access log placeholder: a1");
});
