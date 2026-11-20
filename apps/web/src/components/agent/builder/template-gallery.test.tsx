/** biome-ignore-all lint/suspicious/useAwait: Async act flushes effects. */
import { expect, test } from "bun:test";
import { AGENT_TEMPLATE_IDS, type AgentTemplateId } from "@repo/db/shared";
import { templates } from "@repo/services/agent-builder/templates";
import { type HTMLButtonElement, Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { TemplateGallery, templateLine } from "./template-gallery.tsx";

const noop = () => undefined;

const countButtons = (markup: string): number =>
  markup.split("<button").length - 1;

/** Matches React's text escaping, so markup can be checked for plain text. */
const escapeText = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");

test("gallery shows every template title, first sentence and button", () => {
  const markup = renderToStaticMarkup(
    <TemplateGallery busy={false} onPick={noop} />
  );
  for (const id of AGENT_TEMPLATE_IDS) {
    expect(markup).toContain(templates[id].title);
    expect(markup).toContain(
      escapeText(templateLine(templates[id].description))
    );
  }
  expect(countButtons(markup)).toBe(AGENT_TEMPLATE_IDS.length);
});

test("clicking a template card picks its id once", async () => {
  const dom = new Window();
  const keys = [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Node",
    "IS_REACT_ACT_ENVIRONMENT",
  ];
  const previous = new Map(
    keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  );
  for (const key of keys) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(dom, key),
    });
  }
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container as unknown as Element);
  const picks: AgentTemplateId[] = [];
  const onPick = (id: AgentTemplateId) => {
    picks.push(id);
  };
  try {
    await act(async () =>
      root.render(<TemplateGallery busy={false} onPick={onPick} />)
    );
    const card = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button")
    ).find((button) =>
      button.textContent.includes(templates.inbox_triage.title)
    );
    await act(async () => card?.click());
    expect(picks).toEqual(["inbox_triage"]);
  } finally {
    await act(async () => root.unmount());
    for (const key of keys) {
      const value = previous.get(key);
      if (value) {
        Object.defineProperty(globalThis, key, value);
      } else {
        Reflect.deleteProperty(globalThis, key);
      }
    }
    await dom.happyDOM.close();
  }
});

test("busy disables every template button", () => {
  const markup = renderToStaticMarkup(
    <TemplateGallery busy={true} onPick={noop} />
  );
  expect(countButtons(markup)).toBe(AGENT_TEMPLATE_IDS.length);
  expect(markup.split('disabled=""').length - 1).toBe(
    AGENT_TEMPLATE_IDS.length
  );
});

test("templateLine keeps the first sentence only", () => {
  expect(templateLine("Review shares. Propose a plan.")).toBe("Review shares.");
  expect(templateLine("Only one sentence here.")).toBe(
    "Only one sentence here."
  );
  expect(templateLine("Ask 1.5 times. Done.")).toBe("Ask 1.5 times.");
  expect(templateLine("")).toBe("");
});
