import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NewTeamForm } from "./new-team-dialog.tsx";
import type { TeamAgent } from "./team-logic.ts";

const noop = () => undefined;
const created = () => Promise.resolve();

const agent = (id: string, name: string): TeamAgent => ({
  avatar: { color: "slate", glyph: name.charAt(0) },
  id,
  jobLine: "",
  name,
});

const render = (people: { name: string; userId: string }[] | null) =>
  renderToStaticMarkup(
    <NewTeamForm
      agents={[agent("a1", "Scout"), agent("a2", "Quill")]}
      onCancel={noop}
      onCreate={created}
      people={people}
      youId="u1"
    />
  );

test("the form has the name, agents, lead and people", () => {
  const html = render([
    { name: "Dom", userId: "u1" },
    { name: "Mia", userId: "u2" },
  ]);
  expect(html).toContain("Name");
  expect(html).toContain("Scout");
  expect(html).toContain("Quill");
  expect(html).toContain("Lead");
  expect(html).toContain("Dom (you)");
  expect(html).toContain("Mia");
  expect(html).toContain("Create team");
});

test("a failed people lookup says so", () => {
  expect(render(null)).toContain("could not be loaded");
});
