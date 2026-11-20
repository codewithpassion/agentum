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
const REMOVE_DISABLED_PATTERN =
  /<button\b[^>]*disabled=""[^>]*>Remove<\/button>/;
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

type ConnectorRecord = RouterOutputs["connectors"]["list"][number];

const renderRow = (
  app: AgentKeyApp,
  mine: MySignIn | undefined,
  canEdit = true,
  connector?: ConnectorRecord,
  isAdmin = true
): string =>
  renderInRoom(
    <ul>
      <AppRow
        agentId="agent_1"
        app={app}
        canEdit={canEdit}
        connector={connector}
        isAdmin={isAdmin}
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
  expect(html).not.toContain(">Connect my account<");
  // A working sign-in can still be replaced.
  expect(html).toContain("Reconnect my account");
});

test("An app on a workspace secret names the secret and never claims a sign-in is missing", () => {
  const html = renderRow(
    { ...appNamed("conn_docs"), credentialMode: "user", signIn: null },
    mineWith({ authKind: "header", shared: true }),
    true,
    {
      headerTemplate: "Bearer {value}",
      id: "conn_docs",
      secretId: "secret_1",
      secretName: "Docs key",
      status: "ok",
    } as ConnectorRecord
  );
  expect(html).toContain("Key from secret Docs key");
  expect(html).not.toContain("not signed in");
  expect(html).not.toContain("signed in yet");
  expect(html).not.toContain("no sign-in yet");
  expect(html).not.toContain("Connect my account");
});

test("a connector with a header template and no secret shows the needs secret badge", () => {
  const html = renderRow(appNamed("conn_gmail"), mineWith({}), true, {
    headerTemplate: "Bearer {value}",
    id: "conn_gmail",
    secretId: null,
    status: "ok",
  } as ConnectorRecord);
  expect(html).toContain("needs secret");
});

test("Remove is disabled when the member cannot edit the app", () => {
  const html = renderRow(appNamed("conn_gmail"), mineWith({}), false);
  expect(html).toMatch(REMOVE_DISABLED_PATTERN);
});

test("an OAuth app with no client sends an admin to the Connectors page", () => {
  const needsClient = mineWith({
    oauth: { canRegister: false, clientConfigured: false },
  });
  const admin = renderRow(appNamed("conn_gmail"), needsClient);
  expect(admin).toContain("/settings/connectors");
  const member = renderRow(
    appNamed("conn_gmail"),
    needsClient,
    true,
    undefined,
    false
  );
  expect(member).toContain("needs an admin to set up its client");
  expect(member).not.toContain("/settings/connectors");
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
