import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AddMemberForm } from "./add-member-form.tsx";

const noop = (): undefined => undefined;

const render = (choice: string) =>
  renderToStaticMarkup(
    <AddMemberForm
      busy={false}
      choice={choice}
      choices={[
        { id: "agent_milo", label: "Milo" },
        { id: "agent_ruby", label: "Ruby" },
      ]}
      onChange={noop}
      onSubmit={noop}
      placeholder="Choose an agent"
      selectId="pick-agent"
      title="Add an agent"
    />
  );

const SUBMIT_BUTTON = /<button\b[^>]*type="submit"[^>]*>/;
const DISABLED_ATTR = / disabled=""/;
const MILO_OPTION = /<option [^>]*value="agent_milo"[^>]*>Milo<\/option>/;
const RUBY_OPTION = /<option [^>]*value="agent_ruby"[^>]*>Ruby<\/option>/;

test("renders its title, placeholder and options", () => {
  const html = render("");
  expect(html).toContain("Add an agent");
  expect(html).toContain("Choose an agent");
  expect(html).toMatch(MILO_OPTION);
  expect(html).toMatch(RUBY_OPTION);
  expect(html).toContain('for="pick-agent"');
});

test("the Add button is disabled with no choice", () => {
  const button = render("").match(SUBMIT_BUTTON)?.[0] ?? "";
  expect(button).toMatch(DISABLED_ATTR);
});

test("the Add button is enabled once a choice exists", () => {
  const button = render("agent_milo").match(SUBMIT_BUTTON)?.[0] ?? "";
  expect(button).not.toMatch(DISABLED_ATTR);
});
