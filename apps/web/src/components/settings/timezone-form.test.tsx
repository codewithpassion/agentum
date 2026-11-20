import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TimezoneForm, type TimezoneFormProps } from "./timezone-form.tsx";

const noop = () => undefined;

const baseProps: TimezoneFormProps = {
  error: null,
  isAdmin: true,
  onChange: noop,
  onSave: noop,
  saved: false,
  saving: false,
  value: "Europe/Zurich",
};

const render = (props: Partial<TimezoneFormProps>) =>
  renderToStaticMarkup(<TimezoneForm {...baseProps} {...props} />);

test("an admin gets the labelled input, the help text and a Save button", () => {
  const html = render({});
  expect(html).toContain('for="workspace-timezone"');
  expect(html).toContain("Workspace timezone</label>");
  expect(html).toContain('placeholder="Europe/Zurich"');
  expect(html).toContain('value="Europe/Zurich"');
  expect(html).toContain(
    "Routines read their schedules in this zone unless a routine sets its own."
  );
  expect(html).toContain(">Save</button>");
  expect(html).not.toContain("An admin sets this.");
});

test("a member sees the zone as text, the note and no input or button", () => {
  const html = render({ isAdmin: false });
  expect(html).toContain("Workspace timezone: Europe/Zurich");
  expect(html).toContain("An admin sets this.");
  expect(html).not.toContain("<input");
  expect(html).not.toContain("<button");
});

test("Save is disabled while saving or when the zone is empty", () => {
  expect(render({ saving: true })).toContain('disabled=""');
  expect(render({ value: "   " })).toContain('disabled=""');
  expect(render({})).not.toContain('disabled=""');
});

test("an error shows in destructive text, and saved shows the note", () => {
  const failed = render({ error: "Choose a valid timezone." });
  expect(failed).toContain("text-destructive");
  expect(failed).toContain("Choose a valid timezone.");
  expect(render({ saved: true })).toContain("Saved.");
  expect(render({})).not.toContain("Saved.");
});
