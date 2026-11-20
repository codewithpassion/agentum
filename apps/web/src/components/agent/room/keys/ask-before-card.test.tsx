import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AskBeforeAction } from "#/components/agent/profile/ask-groups.ts";
import { renderInRoom } from "../test-fixtures.tsx";
import { AskBeforeCard, OutsideEmailRow } from "./ask-before-card.tsx";

const BADGE = /<span class="([^"]*)">Always<\/span>/;
const CONTROL_TAG = /<button[^>]*role="(?:switch|radio)"[^>]*>/g;
const DISABLED_ATTR = / disabled=""/;
const REMOVE_OPS = /<button[^>]*aria-label="Remove ops@example.com"[^>]*>/;
const noop = (): undefined => undefined;

test("the Always badge never shrinks or wraps, at any width", () => {
  const html = renderToStaticMarkup(<OutsideEmailRow />);
  const badge = html.match(BADGE);
  expect(badge).not.toBeNull();
  const classes = (badge?.[1] ?? "").split(" ");
  expect(classes).toContain("shrink-0");
  expect(classes).toContain("whitespace-nowrap");
  expect(classes.some((c) => c.includes("max-md"))).toBe(false);
});

const ACTIONS: AskBeforeAction[] = [
  {
    action: "xero.create_bill",
    ask: true,
    group: "Xero",
    kind: "connector",
    label: "Xero: create bill",
    overridden: false,
  },
];

/** Archived opens Advanced from the start, so the switches and mail rows render. */
const cardHtml = (canManage: boolean, mailAllowed: string[] = []): string =>
  renderInRoom(
    <AskBeforeCard
      actions={ACTIONS}
      agentId="agent_1"
      archived
      canManage={canManage}
      level="outside"
      mailAllowed={mailAllowed}
      onEditSettings={noop}
    />
  );

const NOTE =
  "Only the agent&#x27;s owners and admins can change what it asks first.";

/** The opening tags of every switch and radio in the markup. */
const controlTags = (html: string): string[] => html.match(CONTROL_TAG) ?? [];

const isDisabled = (tag: string): boolean => DISABLED_ATTR.test(tag);

test("a plain member sees the note and every ask control disabled", () => {
  const html = cardHtml(false);
  expect(html).toContain(NOTE);
  const controls = controlTags(html);
  expect(controls.length).toBeGreaterThan(0);
  for (const tag of controls) {
    expect(isDisabled(tag)).toBe(true);
  }
});

test("an owner or admin sees no note and the ask controls enabled", () => {
  const html = cardHtml(true);
  expect(html).not.toContain(NOTE);
  const controls = controlTags(html);
  expect(controls.length).toBeGreaterThan(0);
  for (const tag of controls) {
    expect(isDisabled(tag)).toBe(false);
  }
});

test("a plain member cannot remove a mail address the agent may always email", () => {
  const html = cardHtml(false, ["ops@example.com"]);
  const remove = html.match(REMOVE_OPS);
  expect(remove).not.toBeNull();
  expect(isDisabled(remove?.[0] ?? "")).toBe(true);
});

test("an owner or admin can remove a mail address the agent may always email", () => {
  const html = cardHtml(true, ["ops@example.com"]);
  const remove = html.match(REMOVE_OPS);
  expect(remove).not.toBeNull();
  expect(isDisabled(remove?.[0] ?? "")).toBe(false);
});
