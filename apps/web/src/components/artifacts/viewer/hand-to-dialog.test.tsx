import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HandToForm } from "./hand-to-dialog.tsx";
import { handToValue } from "./hand-to-model.ts";

const noop = () => undefined;
const agents = [
  { id: "ag1", name: "Scribe" },
  { id: "ag2", name: "Analyst" },
];

const render = (current: string | null, error: string | null = null) =>
  renderToStaticMarkup(
    <HandToForm
      agents={agents}
      error={error}
      loading={false}
      onSave={noop}
      onSelect={noop}
      saving={false}
      selected={handToValue(current)}
    />
  );

const radio = (html: string, id: string) =>
  html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`))?.[0] ?? "";

test("HandToForm checks the current agent", () => {
  const html = render("ag2");
  expect(html).toContain("Scribe");
  expect(html).toContain("Analyst");
  expect(radio(html, "hand-to-ag2")).toContain('aria-checked="true"');
  expect(radio(html, "hand-to-ag1")).toContain('aria-checked="false"');
  expect(radio(html, "hand-to-nobody")).toContain('aria-checked="false"');
});

test("HandToForm checks Nobody when the artifact is handed to no one", () => {
  const html = render(null);
  expect(html).toContain("Nobody (keep it with me)");
  expect(radio(html, "hand-to-nobody")).toContain('aria-checked="true"');
  expect(radio(html, "hand-to-ag1")).toContain('aria-checked="false"');
});

test("HandToForm shows the error line and a Save button", () => {
  const html = render(null, "Nope");
  expect(html).toContain("Nope");
  expect(html).toContain(">Save</button>");
});
