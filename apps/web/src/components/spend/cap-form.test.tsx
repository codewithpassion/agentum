import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CapForm, type CapFormProps } from "./cap-form.tsx";

const noop = () => undefined;

const baseProps: CapFormProps = {
  error: null,
  help: "Runs stop at this amount.",
  id: "agent-cap",
  label: "Weekly limit",
  onChange: noop,
  onSave: noop,
  saved: false,
  saving: false,
  value: "20",
};

const render = (props: Partial<CapFormProps>) =>
  renderToStaticMarkup(<CapForm {...baseProps} {...props} />);

test("the field is labelled, shows the dollars and has a Save button", () => {
  const html = render({});
  expect(html).toContain('for="agent-cap"');
  expect(html).toContain("Weekly limit</label>");
  expect(html).toContain('value="20"');
  expect(html).toContain('placeholder="No limit"');
  expect(html).toContain("Runs stop at this amount.");
  expect(html).toContain(">Save</button>");
});

test("an error reads as an alert and Saved shows after a save", () => {
  expect(render({ error: "Nope" })).toContain('role="alert"');
  expect(render({ saved: true })).toContain("Saved.");
  expect(render({})).not.toContain("Saved.");
});

test("Save is disabled while saving", () => {
  expect(render({ saving: true })).toContain("disabled");
});
