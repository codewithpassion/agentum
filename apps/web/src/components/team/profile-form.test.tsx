import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProfileForm } from "./profile-form.tsx";

const noop = async (): Promise<void> => undefined;

const render = (initial: { handle: string; name: string } | null) =>
  renderToStaticMarkup(<ProfileForm initial={initial} onSave={noop} />);

test("a saved profile fills in both fields", () => {
  const html = render({ handle: "dom", name: "Dom Fretz" });
  expect(html).toContain('id="profile-name"');
  expect(html).toContain('value="Dom Fretz"');
  expect(html).toContain('id="profile-handle"');
  expect(html).toContain('value="dom"');
});

test("the handle field shows a leading @ and its rules", () => {
  const html = render({ handle: "dom", name: "Dom Fretz" });
  expect(html).toContain(">@<");
  expect(html).toContain(
    "Lowercase letters, digits and single hyphens. Others write @handle to mention you."
  );
});

const FILLED_VALUE = /value="[^"]+"/;

test("with no profile, both fields are empty and the new-handle hint shows", () => {
  const html = render(null);
  expect(html).toContain('id="profile-name"');
  expect(html).toContain('id="profile-handle"');
  expect(html).not.toMatch(FILLED_VALUE);
  expect(html).toContain(
    "You have no handle yet. Set one so people can mention you."
  );
});

test("a saved profile does not show the new-handle hint", () => {
  const html = render({ handle: "dom", name: "Dom Fretz" });
  expect(html).not.toContain("You have no handle yet.");
});

test("the form has a Save button and no status or error before submit", () => {
  const html = render({ handle: "dom", name: "Dom Fretz" });
  expect(html).toContain(">Save<");
  expect(html).not.toContain('role="alert"');
  expect(html).not.toContain('role="status"');
});
