import { expect, test } from "bun:test";
import type { MemoryRules, RememberRules } from "@repo/db/shared";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { RulesPanel } from "./rules-panel.tsx";

const noop = (): void => undefined;

type TestDocument = Window["document"];
type TestElement = NonNullable<ReturnType<TestDocument["querySelector"]>>;

const AGENT_RULES: RememberRules = {
  dreamSchedule: "nightly",
  learnLevel: "tell_after",
  never: ["Client bank details"],
  remember: ["Weekly report deadlines"],
  shareWithTeam: true,
};

const RULES: MemoryRules = {
  agent: AGENT_RULES,
  workspaceNever: [
    "Passwords and keys",
    "Card and bank numbers",
    "Health details",
  ],
};

interface PanelOptions {
  canChange?: boolean;
  rules?: MemoryRules;
  saving?: boolean;
}

const render = ({
  canChange = true,
  rules = RULES,
  saving = false,
}: PanelOptions = {}): TestDocument => {
  const html = renderToStaticMarkup(
    <RulesPanel
      canChange={canChange}
      onChange={noop}
      rules={rules}
      saving={saving}
    />
  );
  const { document } = new Window();
  document.body.innerHTML = html;
  return document;
};

const section = (document: TestDocument, title: string): TestElement => {
  const heading = [...document.querySelectorAll("h3")].find(
    (candidate) => candidate.textContent === title
  );
  const found = heading?.closest("section");
  if (found === undefined || found === null) {
    throw new Error(`No section titled ${title}`);
  }
  return found;
};

const CONTROLS = "button, input";

test("workspace rules are locked rows and only the agent's own never rule has Remove", () => {
  const document = render();
  const locked = document.querySelectorAll('[data-testid="locked-rule"]');
  expect(locked.length).toBe(3);
  for (const row of locked) {
    expect(row.textContent).toContain("workspace rule");
    expect(row.querySelector("button")).toBeNull();
  }
  const never = section(document, "Never remember");
  expect(never.textContent).toContain("Client bank details");
  const removeButtons = [...never.querySelectorAll("button")].filter(
    (button) => button.textContent === "Remove"
  );
  expect(removeButtons.length).toBe(1);
  const agentRow = [...never.querySelectorAll("li")].find((row) =>
    row.textContent.includes("Client bank details")
  );
  expect(agentRow?.querySelector("button")?.textContent).toBe("Remove");
  expect(agentRow?.textContent).not.toContain("workspace rule");
});

test("the Remember list shows its entries", () => {
  const remember = section(render(), "Remember");
  expect(remember.textContent).toContain("Weekly report deadlines");
});

test("the three learn levels show their hints, with the agent's level checked", () => {
  const learn = section(render(), "How it learns");
  const options = [...learn.querySelectorAll("label")];
  expect(options.length).toBe(3);
  const expected = [
    ["Ask me first", "Every new note waits for your approval.", "false"],
    [
      "Tell me after",
      "Notes apply at once and show under Learned this week.",
      "true",
    ],
    [
      "Quietly",
      "Notes apply at once and show only in the dream diary.",
      "false",
    ],
  ] as const;
  for (const [index, [label, hint, checked]] of expected.entries()) {
    const option = options[index];
    expect(option?.textContent).toContain(label);
    expect(option?.textContent).toContain(hint);
    expect(
      option?.querySelector('[role="radio"]')?.getAttribute("aria-checked")
    ).toBe(checked);
  }
});

test("the Shares with team switch shows the agent's setting", () => {
  const shared = render().querySelector(
    '[role="switch"][aria-label="Shares with team"]'
  );
  expect(shared?.getAttribute("aria-checked")).toBe("true");
  const notShared = render({
    rules: { ...RULES, agent: { ...AGENT_RULES, shareWithTeam: false } },
  }).querySelector('[role="switch"][aria-label="Shares with team"]');
  expect(notShared?.getAttribute("aria-checked")).toBe("false");
});

test("without permission the owner line shows and every control is disabled", () => {
  const document = render({ canChange: false });
  expect(document.body.textContent).toContain(
    "Only the owner or an admin can change these."
  );
  const controls = [
    ...document.querySelectorAll(`${CONTROLS}, [role="switch"]`),
  ];
  expect(controls.length).toBeGreaterThan(0);
  for (const control of controls) {
    expect(control.hasAttribute("disabled")).toBe(true);
  }
});

test("with permission the owner line is absent and no control is disabled", () => {
  const document = render({ canChange: true });
  expect(document.body.textContent).not.toContain(
    "Only the owner or an admin can change these."
  );
  const controls = [
    ...document.querySelectorAll(`${CONTROLS}, [role="switch"]`),
  ];
  expect(controls.length).toBeGreaterThan(0);
  for (const control of controls) {
    expect(control.hasAttribute("disabled")).toBe(false);
  }
});

test("while saving every control is disabled even with permission", () => {
  const document = render({ canChange: true, saving: true });
  const controls = [
    ...document.querySelectorAll(`${CONTROLS}, [role="switch"]`),
  ];
  expect(controls.length).toBeGreaterThan(0);
  for (const control of controls) {
    expect(control.hasAttribute("disabled")).toBe(true);
  }
});
