import { expect, test } from "bun:test";
import type { AgentKeyApp } from "@repo/db/shared";
import type { RouterOutputs } from "#/integrations/trpc/types";
import { fixtureKeys, renderInRoom } from "../test-fixtures.tsx";
import { AppRow } from "./app-row.tsx";

type MySignIn = RouterOutputs["connectors"]["mine"][number];

const noop = (): void => undefined;

const CONNECT_LINK_PATTERN =
  /<a\b[^>]*href="\/connect\/conn_gmail\?[^"]*agents%2Fagent_1%3Ftab%3Dkeys[^"]*"[^>]*>Connect my account<\/a>/;
const ALLOWED_TOOLS_DISABLED_PATTERN =
  /<button\b[^>]*disabled=""[^>]*>Allowed tools<\/button>/;
const SELECT_DISABLED_PATTERN = /<select\b[^>]*disabled=""/;
const CONNECT_BUTTON_PATTERN = /<button\b[^>]*>Connect my account<\/button>/;

const appNamed = (connectorId: string): AgentKeyApp => {
  const app = fixtureKeys().apps.find(
    (item) => item.connectorId === connectorId
  );
  if (app === undefined) {
    throw new Error(`Fixture app ${connectorId} is missing`);
  }
  return app;
};

const mineWith = (overrides: Partial<MySignIn>): MySignIn => ({
  authKind: "oauth",
  id: "conn_gmail",
  myCredential: null,
  name: "Gmail",
  oauth: null,
  shared: false,
  status: "ok",
  url: "https://gmail.example.com/mcp",
  ...overrides,
});

const signedInCredential = {
  createdAt: "2026-11-01T00:00:00.000Z",
  id: "cred_1",
  ownerId: "user_1",
  ownerKind: "user",
  status: "ok",
  updatedAt: "2026-11-01T00:00:00.000Z",
  version: 1,
} as const;

const renderRow = (
  app: AgentKeyApp,
  mine: MySignIn | undefined,
  canEdit = true
): string =>
  renderInRoom(
    <ul>
      <AppRow
        agentId="agent_1"
        app={app}
        canEdit={canEdit}
        mine={mine}
        onChangeMode={noop}
        onChooseTools={noop}
        onPaste={noop}
        onRemove={noop}
      />
    </ul>
  );

test("A signed-in app says whose sign-in it uses and that the member is signed in", () => {
  const html = renderRow(
    appNamed("conn_gmail"),
    mineWith({ myCredential: signedInCredential })
  );
  expect(html).toContain("Uses the sign-in of the person asking, or its own.");
  expect(html).toContain("You are signed in.");
  expect(html).not.toContain("Connect my account");
});

test("An app the member has not connected offers Connect my account as a link", () => {
  const html = renderRow(appNamed("conn_gmail"), mineWith({}));
  expect(html).toMatch(CONNECT_LINK_PATTERN);
});

test("An app that needs no sign-in says so and offers no connect action", () => {
  const html = renderRow(appNamed("conn_docs"), mineWith({ authKind: "none" }));
  expect(html).toContain("No sign-in needed.");
  expect(html).not.toContain("Connect my account");
  expect(html).not.toContain("not signed in");
  expect(html).not.toContain("no sign-in yet");
});

test("Without the member's connector loaded, no sign-in status or connect action shows", () => {
  const html = renderRow(appNamed("conn_gmail"), undefined);
  expect(html).not.toContain("You are signed in.");
  expect(html).not.toContain("No sign-in needed.");
  expect(html).not.toContain("Connect my account");
});

test("Without edit rights the tools button and the mode select are disabled", () => {
  const html = renderRow(appNamed("conn_gmail"), mineWith({}), false);
  expect(html).toMatch(ALLOWED_TOOLS_DISABLED_PATTERN);
  expect(html).toMatch(SELECT_DISABLED_PATTERN);
});

test("A header app offers Connect my account as a button", () => {
  const html = renderRow(
    appNamed("conn_gmail"),
    mineWith({ authKind: "header" })
  );
  expect(html).toMatch(CONNECT_BUTTON_PATTERN);
});
