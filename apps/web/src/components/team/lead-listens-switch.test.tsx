import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LeadListensSwitch } from "./lead-listens-switch.tsx";

const noop = async (): Promise<void> => undefined;
const SWITCH_OPENING = /<button[^>]*role="switch"[^>]*>/;

const render = (checked: boolean) =>
  renderToStaticMarkup(<LeadListensSwitch checked={checked} onChange={noop} />);

test("the switch is labelled Lead listens and keeps the sentence as its description", () => {
  const html = render(true);
  expect(html).toContain('for="team-lead-listens"');
  expect(html).toContain("Lead listens</label>");
  expect(html).toContain(
    "The lead hears room messages that name nobody, and hands the work out."
  );
  expect(html.match(SWITCH_OPENING)?.[0]).toContain(
    'aria-describedby="team-lead-listens-help"'
  );
});

test("the switch shows the saved setting", () => {
  expect(render(true).match(SWITCH_OPENING)?.[0]).toContain(
    'aria-checked="true"'
  );
  expect(render(false).match(SWITCH_OPENING)?.[0]).toContain(
    'aria-checked="false"'
  );
});
