import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RulesEditor } from "./rules-editor.tsx";
import { RULES_MAX } from "./team-logic.ts";

const noop = async (): Promise<void> => undefined;

const SAVE_BUTTON = /<button[^>]*>Save<\/button>/;

const render = (props: { canEdit: boolean; rules: string }) =>
  renderToStaticMarkup(
    <RulesEditor canEdit={props.canEdit} onSave={noop} rules={props.rules} />
  );

test("an editor shows the rules in a labelled textarea with a length limit", () => {
  const html = render({ canEdit: true, rules: "Be kind." });
  expect(html).toContain('for="team-rules"');
  expect(html).toContain("Team rules");
  expect(html).toContain("<textarea");
  expect(html).toContain("Be kind.</textarea>");
  expect(html).toContain(`maxLength="${RULES_MAX}"`);
  expect(html).toContain(
    "Every member reads these before each room message. Posts from the room stay outside them."
  );
});

test("Save is disabled while the text matches the saved rules", () => {
  const html = render({ canEdit: true, rules: "Be kind." });
  expect(html).toMatch(SAVE_BUTTON);
  expect(html.match(SAVE_BUTTON)?.[0]).toContain("disabled");
});

test("a reader sees the rules without an editor or Save", () => {
  const html = render({ canEdit: false, rules: "Be kind." });
  expect(html).toContain("Be kind.");
  expect(html).not.toContain("<textarea");
  expect(html).not.toContain("Save");
});

test("empty rules read as No rules yet. for a reader", () => {
  const html = render({ canEdit: false, rules: "" });
  expect(html).toContain("No rules yet.");
});

test("rules text is escaped, not run as markup", () => {
  const html = render({ canEdit: false, rules: "<script>alert(1)</script>" });
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
});
