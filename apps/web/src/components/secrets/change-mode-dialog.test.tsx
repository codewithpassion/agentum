/** biome-ignore-all lint/suspicious/useAwait: Async act flushes effects and promises. */
import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { getTrpc as realGetTrpc } from "#/integrations/trpc/client";
import { ChangeModeForm } from "./change-mode-dialog.tsx";
import type { SecretRecord } from "./secret-model.ts";
import { SecretsTable } from "./secrets-table.tsx";

const dom = new Window({ url: "https://preview.agentum.test" });
const previous = new Map<string, PropertyDescriptor | undefined>();
const keys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "getComputedStyle",
  "ResizeObserver",
  "MutationObserver",
  "CustomEvent",
  "KeyboardEvent",
  "HTMLFormElement",
  "HTMLInputElement",
  "HTMLButtonElement",
  "Event",
  "MouseEvent",
  "Node",
  "IS_REACT_ACT_ENVIRONMENT",
];

const update = mock((_input: unknown) => Promise.resolve({}));
const connectorList = mock(() =>
  Promise.resolve([
    { name: "Docs", secretId: "s1", url: "https://docs.example.net/mcp" },
  ])
);

const secretOf = (overrides: Partial<SecretRecord>): SecretRecord =>
  ({
    allowedHosts: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    id: "s1",
    mode: "proxy",
    name: "SUPADATA_KEY",
    rules: [],
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  }) as SecretRecord;

beforeAll(() => {
  for (const key of keys) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(dom, key),
    });
  }
  mock.module("#/integrations/trpc/client", () => ({
    getTrpc: () => ({
      connectors: { list: { query: connectorList } },
      secrets: { update: { mutate: update } },
    }),
  }));
});

afterAll(() => {
  mock.module("#/integrations/trpc/client", () => ({ getTrpc: realGetTrpc }));
  for (const [key, descriptor] of previous) {
    if (descriptor) {
      Object.defineProperty(globalThis, key, descriptor);
    } else {
      Reflect.deleteProperty(globalThis, key);
    }
  }
});

beforeEach(() => {
  update.mockClear();
});

const submitOf = (container: HTMLElement): HTMLButtonElement => {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === "Change mode"
  );
  if (button === undefined) {
    throw new Error("the Change mode button is missing");
  }
  return button as HTMLButtonElement;
};

const done = () => Promise.resolve();

const renderForm = async (secret: SecretRecord) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () =>
    root.render(<ChangeModeForm onDone={done} secret={secret} />)
  );
  return {
    container,
    unmount: () =>
      act(async () => {
        root.unmount();
        container.remove();
      }),
  };
};

test("a proxy secret switches to env with its rule hosts as allowed hosts, through secrets.update", async () => {
  const { container, unmount } = await renderForm(
    secretOf({
      mode: "proxy",
      rules: [
        { header: "x-api-key", host: "api.supadata.ai", template: "{value}" },
      ],
    })
  );
  try {
    await act(async () => submitOf(container).click());
    expect(update).toHaveBeenCalledWith({
      id: "s1",
      patch: { allowedHosts: ["api.supadata.ai"], mode: "env" },
    });
  } finally {
    await unmount();
  }
});

test("an env secret switches to proxy with Authorization and Bearer {value} as defaults", async () => {
  const { container, unmount } = await renderForm(
    secretOf({ allowedHosts: ["api.supadata.ai"], mode: "env" })
  );
  try {
    await act(async () => submitOf(container).click());
    expect(update).toHaveBeenCalledWith({
      id: "s1",
      patch: {
        mode: "proxy",
        rules: [
          {
            header: "Authorization",
            host: "api.supadata.ai",
            template: "Bearer {value}",
          },
        ],
      },
    });
  } finally {
    await unmount();
  }
});

test("the dialog warns when a linked connector's host would not be allowed", async () => {
  const { container, unmount } = await renderForm(
    secretOf({ allowedHosts: ["api.supadata.ai"], mode: "env" })
  );
  try {
    expect(container.textContent).toContain("Docs uses this secret");
  } finally {
    await unmount();
  }
});

test("the service's error is shown as it is", async () => {
  update.mockImplementationOnce(() =>
    Promise.reject(
      new Error("A proxy secret's value may hold printable ASCII only")
    )
  );
  const { container, unmount } = await renderForm(
    secretOf({ allowedHosts: ["api.supadata.ai"], mode: "env" })
  );
  try {
    await act(async () => submitOf(container).click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "A proxy secret's value may hold printable ASCII only"
    );
  } finally {
    await unmount();
  }
});

const noop = () => undefined;

const tableProps = {
  onChangeMode: noop,
  onDelete: noop,
  onEditHosts: noop,
  onEditRules: noop,
  onReplace: noop,
  secrets: [secretOf({ mode: "env" })],
};

const disabledButtons = (markup: string): string[] =>
  [...markup.matchAll(/<button[^>]*>[^<]*<\/button>/g)]
    .map((match) => match[0])
    .filter((button) => button.includes(' disabled=""'))
    .map((button) => button.replace(/<[^>]+>/g, "").trim());

test("the table always shows Change mode, and disables every action without canManage", () => {
  const member = renderToStaticMarkup(
    <SecretsTable {...tableProps} canManage={false} />
  );
  expect(member).toContain("Change mode");
  expect(disabledButtons(member)).toEqual([
    "Replace value",
    "Edit hosts",
    "Change mode",
    "Delete",
  ]);

  const admin = renderToStaticMarkup(
    <SecretsTable {...tableProps} canManage />
  );
  expect(admin).toContain("Change mode");
  expect(disabledButtons(admin)).toEqual([]);
});
