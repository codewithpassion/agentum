import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PlainChoicesView } from "./plain-choices.tsx";

const noop = () => undefined;

/** True when the option with this value carries `selected`. */
const isSelected = (html: string, value: string): boolean =>
  new RegExp(`<option[^>]*value="${value}"[^>]*selected`).test(html);

const render = (
  model: string,
  runtimeConfig: Record<string, unknown> = {},
  disabled = false
) =>
  renderToStaticMarkup(
    <PlainChoicesView
      disabled={disabled}
      model={model}
      onContext={noop}
      onModel={noop}
      onThinking={noop}
      runtimeConfig={runtimeConfig}
    />
  );

test("shows the three plain choices with their labels", () => {
  const html = render("sonnet");
  expect(html).toContain("Capability");
  expect(html).toContain("Thinking level");
  expect(html).toContain("Context size");
  expect(html).toContain("Most capable");
  expect(html).toContain("Thorough");
  expect(html).toContain("Standard");
});

test("an agent with nothing set reads Default for thinking and context", () => {
  const html = render("sonnet");
  expect(isSelected(html, "")).toBe(true);
  expect(html).not.toContain("Custom (");
});

test("saved values are the selected options", () => {
  const html = render("claude-opus-5-5", {
    contextBudget: "large",
    effort: "high",
  });
  expect(isSelected(html, "opus")).toBe(true);
  expect(isSelected(html, "high")).toBe(true);
  expect(isSelected(html, "large")).toBe(true);
  expect(isSelected(html, "sonnet")).toBe(false);
});

test("a model outside the three tiers shows as custom and is kept", () => {
  const html = render("openrouter:z-ai/glm-5.3");
  expect(html).toContain("Custom (openrouter:z-ai/glm-5.3)");
  expect(isSelected(html, "other")).toBe(true);
});

test("every select is disabled while a save is in flight", () => {
  const html = render("sonnet", {}, true);
  expect(html.match(/<select[^>]*disabled/g)).toHaveLength(3);
});
