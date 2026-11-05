/** biome-ignore-all lint/suspicious/useAwait: React act flushes effects. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantCard, type CardApi } from "./cards";
import type { PendingCard } from "./types";

const dom = new Window({ url: "http://localhost/" });
const previous = new Map<string, PropertyDescriptor | undefined>();
beforeAll(() => {
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Node",
    "getComputedStyle",
    "Event",
    "IS_REACT_ACT_ENVIRONMENT",
  ]) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(dom, key),
    });
  }
});
afterAll(() => {
  for (const [key, descriptor] of previous) {
    if (descriptor) {
      Object.defineProperty(globalThis, key, descriptor);
    } else {
      Reflect.deleteProperty(globalThis, key);
    }
  }
});
const noop = () => Promise.resolve();
const secret: PendingCard = {
  arguments: {
    grantTo: ["release"],
    hosts: ["api.github.com"],
    mode: "env",
    name: "GITHUB_TOKEN",
    reason: "Release bot needs GitHub access.",
  },
  kind: "secret",
  title: "Add secret",
  tool: "request_secret",
  toolUseId: "s1",
};

async function mount(
  card = secret,
  options: {
    failCreate?: boolean;
    failResolve?: boolean;
    hold?: Promise<void>;
    recoveryKey?: string;
  } = {}
) {
  const calls: { procedure: string; input: unknown }[] = [];
  const api: CardApi = {
    createSecret: async (input) => {
      calls.push({ input, procedure: "secrets.create" });
      await options.hold;
      if (options.failCreate) {
        throw new Error("Name already exists");
      }
      return { id: "secret1" };
    },
    getGrants: async () => ["existing"],
    setGrants: async (input) => {
      calls.push({ input, procedure: "secrets.setGrants" });
    },
    setModelKey: async (input) => {
      calls.push({ input, procedure: "modelKeys.set" });
    },
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  const resolve = async (input: import("./types").CardOutcome) => {
    calls.push({ input, procedure: "assistant.resolveCard" });
    if (options.failResolve) {
      options.failResolve = false;
      throw new Error("Connection lost");
    }
  };
  await act(async () =>
    root.render(
      <AssistantCard
        agents={[
          { id: "a1", name: "Release bot", slug: "release" },
          { id: "a2", name: "Review bot", slug: "review" },
        ]}
        api={api}
        card={card}
        // biome-ignore lint/performance/noJsxPropsBind: Test callback created once per mount.
        onResolve={resolve}
        recoveryKey={options.recoveryKey}
      />
    )
  );
  const button = (label: string) =>
    Array.from(container.querySelectorAll("button")).find(
      (node) => node.textContent === label
    );
  const click = async (label: string) => {
    await act(async () => button(label)?.click());
  };
  const fillValue = async () => {
    const input = container.querySelector(
      'input[aria-label="Value"]'
    ) as unknown as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        dom.HTMLInputElement.prototype,
        "value"
      )?.set;
      setter?.call(input, "test-sensitive-value");
      input.dispatchEvent(
        new dom.Event("input", { bubbles: true }) as unknown as Event
      );
    });
  };
  return {
    calls,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
    click,
    container,
    fillValue,
  };
}

test("secret value is masked, ignores password managers, and is sent only to secrets.create; grants preserve existing secrets", async () => {
  const view = await mount();
  try {
    const input = view.container.querySelector('input[aria-label="Value"]');
    expect(input?.getAttribute("type")).toBe("text");
    expect(
      renderToStaticMarkup(
        <AssistantCard agents={[]} card={secret} onResolve={noop} />
      )
    ).toContain("-webkit-text-security:disc");
    for (const name of ["data-1p-ignore", "data-bwignore"]) {
      expect(input?.hasAttribute(name)).toBe(true);
    }
    expect(input?.getAttribute("data-lpignore")).toBe("true");
    expect(input?.getAttribute("autocomplete")).toBe("off");
    await view.click("Show");
    expect(input?.getAttribute("type")).toBe("text");
    await view.fillValue();
    await view.click("Save securely");
    expect(
      view.calls.find((call) => call.procedure === "secrets.create")?.input
    ).toEqual({
      allowedHosts: ["api.github.com"],
      mode: "env",
      name: "GITHUB_TOKEN",
      value: "test-sensitive-value",
    });
    expect(
      view.calls.find((call) => call.procedure === "secrets.setGrants")?.input
    ).toEqual({ agentId: "a1", secretIds: ["existing", "secret1"] });
    expect(
      JSON.stringify(
        view.calls.filter((call) => call.procedure.startsWith("assistant."))
      )
    ).not.toContain("test-sensitive-value");
    expect(view.container.textContent).toContain(
      "Saved secret GITHUB_TOKEN, granted to Release bot"
    );
    expect(
      view.container.querySelector('input[aria-label="Value"]')
    ).toBeNull();
  } finally {
    await view.cleanup();
  }
});

test("saving disables the card, and a rejected save leaves the card open with its error", async () => {
  let release: () => void = () => undefined;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const view = await mount(secret, { failCreate: true, hold });
  try {
    await view.fillValue();
    await view.click("Save securely");
    expect(view.container.textContent).toContain("Saving");
    expect(view.container.querySelector("fieldset")?.disabled).toBe(true);
    await act(async () => release());
    expect(view.container.textContent).toContain("Name already exists");
    expect(
      view.container.querySelector('input[aria-label="Value"]')
    ).not.toBeNull();
    expect(
      view.calls.some((call) => call.procedure === "assistant.resolveCard")
    ).toBe(false);
  } finally {
    await view.cleanup();
  }
});

test("a failed outcome delivery retries resolveCard without creating or granting again", async () => {
  const view = await mount(secret, { failResolve: true });
  try {
    await view.fillValue();
    await view.click("Save securely");
    expect(view.container.textContent).toContain("Connection lost");
    await view.click("Retry outcome");
    expect(
      view.calls.filter((call) => call.procedure === "secrets.create")
    ).toHaveLength(1);
    expect(
      view.calls.filter((call) => call.procedure === "secrets.setGrants")
    ).toHaveLength(1);
    expect(
      view.calls.filter((call) => call.procedure === "assistant.resolveCard")
    ).toHaveLength(2);
  } finally {
    await view.cleanup();
  }
});

test("decline resolves without storing and collapses to a declined line", async () => {
  const view = await mount();
  try {
    await view.click("Decline");
    expect(view.calls).toEqual([
      {
        input: { reason: "declined", saved: false },
        procedure: "assistant.resolveCard",
      },
    ]);
    expect(view.container.textContent).toContain("Declined");
  } finally {
    await view.cleanup();
  }
});

for (const provider of ["anthropic", "openrouter"] as const) {
  test(`${provider} card stores directly and sends only the provider outcome to the assistant`, async () => {
    const view = await mount({
      ...secret,
      arguments: { provider, reason: "A model key is needed." },
      kind: "model_key",
    });
    try {
      await view.fillValue();
      await view.click("Save securely");
      expect(view.calls).toEqual([
        {
          input: { apiKey: "test-sensitive-value", provider },
          procedure: "modelKeys.set",
        },
        {
          input: { provider, saved: true },
          procedure: "assistant.resolveCard",
        },
      ]);
    } finally {
      await view.cleanup();
    }
  });
}
for (const [label, run] of [
  ["Run", true],
  ["Don't run", false],
] as const) {
  test(`confirm card sends ${label}`, async () => {
    const view = await mount({
      ...secret,
      arguments: { agentId: "a1" },
      kind: "confirm",
      title: "Archive agent",
      tool: "archive_agent",
    });
    try {
      await view.click(label);
      expect(view.calls).toEqual([
        { input: { run }, procedure: "assistant.resolveCard" },
      ]);
    } finally {
      await view.cleanup();
    }
  });
}

test("reload after storage succeeds retries only the recorded outcome", async () => {
  const first = await mount(secret, {
    failResolve: true,
    recoveryKey: "recovery-test",
  });
  await first.fillValue();
  await first.click("Save securely");
  expect(first.container.textContent).toContain("Connection lost");
  expect(
    dom.sessionStorage.getItem("assistant-card:recovery-test")
  ).not.toContain("test-sensitive-value");
  await first.cleanup();
  const second = await mount(secret, { recoveryKey: "recovery-test" });
  try {
    await second.click("Retry outcome");
    expect(second.calls.map((call) => call.procedure)).toEqual([
      "assistant.resolveCard",
    ]);
    expect(
      dom.sessionStorage.getItem("assistant-card:recovery-test")
    ).toBeNull();
  } finally {
    await second.cleanup();
  }
});

for (const ref of ["a1", "release"]) {
  test(`agent picker prefills ${ref} and saves edited selections by ID`, async () => {
    const view = await mount({
      ...secret,
      arguments: { ...secret.arguments, grantTo: [ref] },
    });
    try {
      const checkboxes = Array.from(
        view.container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')
      );
      expect(checkboxes).toHaveLength(2);
      expect(checkboxes[0]?.getAttribute("aria-checked")).toBe("true");
      expect(checkboxes[1]?.getAttribute("aria-checked")).toBe("false");
      await act(async () => {
        checkboxes[0]?.click();
        checkboxes[1]?.click();
      });
      await view.fillValue();
      await view.click("Save securely");
      expect(
        view.calls.find((call) => call.procedure === "secrets.setGrants")?.input
      ).toEqual({ agentId: "a2", secretIds: ["existing", "secret1"] });
      expect(
        view.calls.find((call) => call.procedure === "assistant.resolveCard")
          ?.input
      ).toMatchObject({ grantedTo: ["a2"] });
    } finally {
      await view.cleanup();
    }
  });
}

test("card reason is explanatory text under the title", async () => {
  const view = await mount();
  try {
    expect(view.container.querySelector("legend + p")?.textContent).toBe(
      String(secret.arguments.reason)
    );
    expect(view.container.querySelector('input[id$="-reason"]')).toBeNull();
  } finally {
    await view.cleanup();
  }
});

test("agent picker explains when there are no active agents", () => {
  const html = renderToStaticMarkup(
    <AssistantCard agents={[]} card={secret} onResolve={noop} />
  );
  expect(html).toContain("No active agents in this workspace.");
});
