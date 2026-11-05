/** biome-ignore-all lint/suspicious/useAwait: Async act flushes effects and promises. */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { getTrpc as realGetTrpc } from "#/integrations/trpc/client";
import { Calls } from "./calls.tsx";
import { ShareBody } from "./share-dialog.tsx";

const dom = new Window({ url: "https://preview.agentum.test" });
const previous = new Map<string, PropertyDescriptor | undefined>();
const keys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Node",
  "IS_REACT_ACT_ENVIRONMENT",
];
const fullUrl = "https://preview.agentum.test/hooks/token/discord";
const writeText = mock(() => Promise.resolve());

beforeAll(() => {
  for (const key of keys) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(dom, key),
    });
  }
  Object.defineProperty(dom.navigator, "clipboard", { value: { writeText } });
  mock.module("#/integrations/trpc/client", () => ({
    getTrpc: () => ({
      artifacts: {
        appErrors: {
          query: () =>
            Promise.resolve([
              {
                dropped: 0,
                entry: "server.ts",
                message: "Failed",
                time: "2026-11-05T00:00:00.000Z",
                version: 1,
                versionId: "v1",
              },
            ]),
        },
        calls: {
          query: () =>
            Promise.resolve({
              items: [
                {
                  durationMs: 12,
                  endpoint: "discord",
                  id: "call1",
                  place: null,
                  statusCode: 502,
                  time: "2026-11-05T00:00:00.000Z",
                  version: 1,
                },
              ],
            }),
        },
        endpoints: {
          query: () =>
            Promise.resolve([
              {
                disabledAt: null,
                id: "ep1",
                name: "discord",
                url: "/hooks/token/discord",
              },
            ]),
        },
        get: {
          query: () =>
            Promise.resolve({
              audience: "workspace",
              canManage: true,
              currentVersion: {
                fileCount: 1,
                id: "v1",
                number: 1,
                totalBytes: 10,
              },
              kind: "app",
              linksEnabled: false,
            }),
        },
        grants: { query: () => Promise.resolve([]) },
        shares: { query: () => Promise.resolve([]) },
        versions: { query: () => Promise.resolve([{ id: "v1", number: 1 }]) },
      },
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

test("endpoints precede Recent errors and calls, and Copy writes the full URL", async () => {
  const container = document.createElement("div");
  const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<Calls artifactId="a1" />));
    const text = container.textContent ?? "";
    expect(text).toContain(fullUrl);
    expect(text.indexOf(fullUrl)).toBeLessThan(text.indexOf("Recent errors"));
    expect(text.indexOf("Recent errors")).toBeLessThan(text.indexOf("Status"));
    const url = [...container.querySelectorAll("p")].find(
      (p) => p.textContent === fullUrl
    );
    expect(url?.className).toContain("font-mono");
    expect(url?.className).toContain("break-all");
    const copy = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Copy"
    );
    if (copy === undefined) {
      throw new Error("Copy button is missing");
    }
    await act(async () => copy.click());
    expect(writeText).toHaveBeenCalledWith(fullUrl);
    expect(container.textContent).toContain("Copied");
  } finally {
    await act(async () => root.unmount());
  }
});

test("Share dialog renders sharing controls without the endpoint list", async () => {
  const container = document.createElement("div");
  const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ShareBody artifactId="a1" />));
    expect(container.textContent).toContain("Who can open it");
    expect(container.textContent).toContain("Links");
    expect(container.textContent).not.toContain("Public endpoints");
    expect(container.textContent).not.toContain(fullUrl);
  } finally {
    await act(async () => root.unmount());
  }
});
