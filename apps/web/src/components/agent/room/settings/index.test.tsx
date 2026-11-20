import { expect, mock, test } from "bun:test";
import type { WorkspaceMember } from "@repo/db/shared";
import {
  fixtureRoom,
  fixtureTabProps,
  renderInRoom,
} from "../test-fixtures.tsx";

// The Owner select reads Clerk's auth state, which needs a provider. Each test sets who is signed in.
let signedIn = { orgRole: "org:member", userId: "user_1" };
mock.module("@clerk/tanstack-react-start", () => ({
  useAuth: () => signedIn,
}));

const { SettingsTab } = await import("./index.tsx");

const OWNER: WorkspaceMember = { name: "Ada", userId: "user_1" };
const BACKUP: WorkspaceMember = { name: "Ben", userId: "user_2" };

const renderSettings = (): string => {
  const room = fixtureRoom();
  return renderInRoom(
    <SettingsTab
      {...fixtureTabProps()}
      room={{ ...room, members: [OWNER, BACKUP] }}
    />
  );
};

/** A label's `for` id and its text, for each label in the markup. */
const LABEL_FOR = /<label[^>]*for="([^"]+)"[^>]*>([^<]*)<\/label>/g;
const DISABLED_ATTR = /\sdisabled=""/;

/** The trigger button that a label names, taken from the label's `for` id. */
const triggerFor = (html: string, label: string): string => {
  const forId = [...html.matchAll(LABEL_FOR)].find(
    (match) => match[2] === label
  )?.[1];
  if (forId === undefined) {
    throw new Error(`No label ${label} in the Settings markup`);
  }
  const idAt = html.indexOf(`id="${forId}"`);
  const start = html.lastIndexOf("<", idAt);
  const tag = html.slice(start, html.indexOf(">", idAt) + 1);
  if (!tag.startsWith("<button")) {
    throw new Error(`The ${label} control is not a button`);
  }
  return tag;
};

const isDisabled = (tag: string): boolean => DISABLED_ATTR.test(tag);

const AGENT_CAP_INPUT = /id="agent-cap"[^>]*value="20"/;

test("Settings shows where the agent runs, the move action and the agent form", () => {
  signedIn = { orgRole: "org:member", userId: "user_1" };
  const html = renderInRoom(<SettingsTab {...fixtureTabProps()} />);
  expect(html).toContain("Runs on");
  expect(html).toContain("Move agent");
  expect(html).toContain("Edit agent");
  expect(html).toContain("Cloud");
});

test("Settings names the machine the agent runs on", () => {
  signedIn = { orgRole: "org:member", userId: "user_1" };
  const props = fixtureTabProps();
  const base = props.room;
  const html = renderInRoom(
    <SettingsTab
      {...props}
      room={{
        ...base,
        agent: { ...base.agent, runtime: "machine" },
        profile: {
          ...base.profile,
          header: {
            ...base.profile.header,
            machine: { id: "m1", name: "laptop", status: "online" },
            runtime: "machine",
          },
        },
      }}
    />
  );
  expect(html).toContain("laptop");
});

test("the owner can change the Owner and Backup selects", () => {
  signedIn = { orgRole: "org:member", userId: "user_1" };
  const html = renderSettings();
  expect(isDisabled(triggerFor(html, "Owner"))).toBe(false);
  expect(isDisabled(triggerFor(html, "Backup"))).toBe(false);
});

test("an org admin who is not the owner can change the Owner and Backup selects", () => {
  signedIn = { orgRole: "org:admin", userId: "user_9" };
  const html = renderSettings();
  expect(isDisabled(triggerFor(html, "Owner"))).toBe(false);
  expect(isDisabled(triggerFor(html, "Backup"))).toBe(false);
});

test("a member who is neither the owner nor an admin sees the Owner and Backup selects disabled", () => {
  signedIn = { orgRole: "org:member", userId: "user_3" };
  const html = renderSettings();
  expect(isDisabled(triggerFor(html, "Owner"))).toBe(true);
  expect(isDisabled(triggerFor(html, "Backup"))).toBe(true);
});

test("Settings has a weekly spend limit that shows the saved cap", () => {
  const props = fixtureTabProps();
  const base = props.room;
  const html = renderInRoom(
    <SettingsTab
      {...props}
      room={{ ...base, spend: { ...base.spend, capCents: 2000 } }}
    />
  );
  expect(html).toContain("Weekly spend limit");
  expect(html).toContain("Weekly limit");
  expect(html).toMatch(AGENT_CAP_INPUT);
});

test("Settings has the three plain choices", () => {
  const html = renderInRoom(<SettingsTab {...fixtureTabProps()} />);
  expect(html).toContain("Capability");
  expect(html).toContain("Thinking level");
  expect(html).toContain("Context size");
});
