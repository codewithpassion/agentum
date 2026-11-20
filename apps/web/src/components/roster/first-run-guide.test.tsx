/** biome-ignore-all lint/suspicious/useAwait: Async act flushes effects. */
import { expect, test } from "bun:test";
import { AGENT_TEMPLATE_IDS } from "@repo/db/shared";
import { templates } from "@repo/services/agent-builder/templates";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { type HTMLTextAreaElement, Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { DESCRIPTION_KEY } from "#/components/agent/builder/builder-logic.ts";
import type { ProviderKeyStatus } from "#/components/model-providers/provider-key-form.tsx";
import { FirstRunGuide } from "./first-run-guide.tsx";

const router = createRouter({
  history: createMemoryHistory({ initialEntries: ["/"] }),
  routeTree: createRootRoute(),
});

const DISABLED_CONTINUE =
  /<button[^>]*disabled=""[^>]*>Continue to the builder/;
const noop = () => undefined;
const saveKey = (): Promise<unknown> => Promise.resolve();

const NO_KEY: ProviderKeyStatus = {
  configured: false,
  hint: null,
  updatedAt: null,
};
const KEY_SET: ProviderKeyStatus = {
  configured: true,
  hint: "wxyz",
  updatedAt: "2026-11-01T00:00:00.000Z",
};

const EXPLANATION =
  "Your agents think on your own Anthropic account, so Anthropic bills you directly for what they use. Paste an API key and you're set.";
const HINT =
  "Add your AI account above to draft from a description. Templates work without one.";

/** Matches React's text escaping, so markup can be checked for plain text. */
const escapeText = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");

const guide = (hasKey: boolean) => (
  <RouterContextProvider router={router}>
    <FirstRunGuide
      anthropic={hasKey ? KEY_SET : NO_KEY}
      hasKey={hasKey}
      onContinue={noop}
      onPickTemplate={noop}
      onSaveKey={saveKey}
    />
  </RouterContextProvider>
);

const renderGuide = (hasKey: boolean) => renderToStaticMarkup(guide(hasKey));

test("without a key the guide shows the key form, its explanation and a disabled continue with the hint", () => {
  const html = renderGuide(false);
  expect(html).toContain('data-testid="first-run-guide"');
  expect(html).toContain('aria-label="First run"');
  expect(html).toContain('id="first-run-api-key"');
  expect(html).toContain(escapeText(EXPLANATION));
  expect(html).toContain(escapeText(HINT));
  expect(html).toMatch(DISABLED_CONTINUE);
});

test("without a key the template cards still show", () => {
  const html = renderGuide(false);
  for (const id of AGENT_TEMPLATE_IDS) {
    expect(html).toContain(templates[id].title);
  }
});

test("with a key the guide shows Done and no key input or hint", () => {
  const html = renderGuide(true);
  expect(html).toContain("Done");
  expect(html).toContain("Your AI account is added.");
  expect(html).toContain('href="/settings/model-providers"');
  expect(html).not.toContain('id="first-run-api-key"');
  expect(html).not.toContain(escapeText(HINT));
  for (const id of AGENT_TEMPLATE_IDS) {
    expect(html).toContain(templates[id].title);
  }
});

const dom = new Window({ url: "http://localhost/" });
const GLOBALS = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Node",
  "IS_REACT_ACT_ENVIRONMENT",
];

const setDescription = async (
  container: HTMLElement,
  text: string
): Promise<void> => {
  const textarea = container.querySelector("textarea");
  const dispatch = (type: string) =>
    textarea?.dispatchEvent(
      new dom.Event(type, { bubbles: true }) as unknown as Event
    );
  await act(async () => {
    // React picks its input-event path when its module loads, before these
    // globals exist. Focus plus keyup covers the fallback path, and input
    // covers the native one.
    dispatch("focusin");
    const setter = Object.getOwnPropertyDescriptor(
      dom.HTMLTextAreaElement.prototype,
      "value"
    )?.set;
    setter?.call(textarea, text);
    dispatch("keyup");
    dispatch("input");
  });
};

/** Mounts the guide in happy-dom with the window globals it needs, then restores them. */
const withDom = async (
  run: (
    container: HTMLElement,
    root: ReturnType<typeof createRoot>
  ) => Promise<void>
): Promise<void> => {
  const previous = new Map(
    GLOBALS.map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ])
  );
  for (const key of GLOBALS) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(dom, key),
    });
  }
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container as unknown as Element);
  try {
    await run(container as unknown as HTMLElement, root);
  } finally {
    await act(async () => root.unmount());
    for (const key of GLOBALS) {
      const value = previous.get(key);
      if (value) {
        Object.defineProperty(globalThis, key, value);
      } else {
        Reflect.deleteProperty(globalThis, key);
      }
    }
    dom.sessionStorage.clear();
    await dom.happyDOM.close();
  }
};

test("typing a description saves it and keeps it when the key flips to added", async () => {
  await withDom(async (container, root) => {
    const text = "Triage my inbox every morning";
    await act(async () => root.render(guide(false)));
    await setDescription(container, text);
    expect(dom.sessionStorage.getItem(DESCRIPTION_KEY)).toBe(text);

    const before = container.querySelector("textarea");
    await act(async () => root.render(guide(true)));
    const after = container.querySelector("textarea");
    expect(after).toBe(before);
    expect((after as unknown as HTMLTextAreaElement).value).toBe(text);
  });
});

test("a saved description is shown when the guide mounts", async () => {
  dom.sessionStorage.setItem(DESCRIPTION_KEY, "Draft the weekly report");
  await withDom(async (container, root) => {
    await act(async () => root.render(guide(false)));
    const textarea = container.querySelector("textarea");
    expect((textarea as unknown as HTMLTextAreaElement).value).toBe(
      "Draft the weekly report"
    );
  });
});
