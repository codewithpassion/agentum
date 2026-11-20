import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DryRunPanel, type DryRunPanelProps } from "./dry-run-panel.tsx";

const noop = () => undefined;
const CREATE_BUTTON = /<button[^>]*>Create agent<\/button>/;
const DISABLED = ' disabled=""';
const KEY_NOTE = "A dry run needs an Anthropic API key in Settings.";

const render = (patch: Partial<DryRunPanelProps>): string =>
  renderToStaticMarkup(
    <DryRunPanel
      createBlocker={null}
      error={null}
      onCreate={noop}
      onDiscard={noop}
      onRun={noop}
      onSample={noop}
      pending={null}
      runBlocker={null}
      runId={null}
      runtimeNote="Note."
      sample={[]}
      {...patch}
    />
  );

const createButton = (html: string): string => {
  const match = CREATE_BUTTON.exec(html);
  return match?.[0] ?? "";
};

test("a missing key stops the dry run and leaves Create open", () => {
  const html = render({ runBlocker: KEY_NOTE });
  expect(createButton(html)).not.toContain(DISABLED);
  expect(html).toContain(KEY_NOTE);
});

test("an open question stops Create", () => {
  const html = render({ createBlocker: "Decide first: Where?" });
  expect(createButton(html)).toContain(DISABLED);
});
