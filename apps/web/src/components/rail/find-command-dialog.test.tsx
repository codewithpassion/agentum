import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FindCommandDialog } from "./find-command-dialog.tsx";

const noop = () => undefined;

test("the Find heading is not in the page while the dialog is closed", () => {
  const html = renderToStaticMarkup(
    <FindCommandDialog
      description="Find a thing"
      onOpenChange={noop}
      open={false}
      title="Find"
    >
      <input aria-label="Search" />
    </FindCommandDialog>
  );
  expect(html).not.toContain("Find");
  expect(html).toBe("");
});
