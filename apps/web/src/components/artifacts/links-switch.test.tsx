import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LinksSwitch } from "./links-switch.tsx";

const noop = () => undefined;

const render = (props: Partial<Parameters<typeof LinksSwitch>[0]> = {}) =>
  renderToStaticMarkup(
    <LinksSwitch
      enabled
      error={null}
      isAdmin
      onChange={noop}
      pending={false}
      {...props}
    />
  );

test("an admin gets a working switch and no admin note", () => {
  const html = render();
  expect(html).toContain("Allow link sharing");
  expect(html).not.toContain('disabled=""');
  expect(html).not.toContain("Only admins can change this.");
});

test("a member sees the switch disabled with a note", () => {
  const html = render({ isAdmin: false });
  expect(html).toContain('disabled=""');
  expect(html).toContain("Only admins can change this.");
});

test("the checked state follows enabled", () => {
  expect(render({ enabled: true })).toContain('aria-checked="true"');
  expect(render({ enabled: false })).toContain('aria-checked="false"');
});

test("a save error shows as an alert", () => {
  const html = render({ error: "Nope" });
  expect(html).toContain('role="alert"');
  expect(html).toContain("Nope");
});
