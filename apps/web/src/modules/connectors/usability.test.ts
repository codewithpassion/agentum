import { describe, expect, test } from "bun:test";
import type { Connector } from "./schema";
import { connectorServerName, isConnectorUsable } from "./usability";

const connector = (overrides: Partial<Connector> = {}): Connector =>
  ({
    authKind: "oauth",
    createdAt: new Date(),
    id: "11111111-2222-3333-4444-555555555555",
    lastError: null,
    mgmtAccessTokenEnc: null,
    mgmtError: null,
    mgmtExpiresAt: null,
    mgmtRefreshTokenEnc: null,
    name: "Linear",
    oauthClientId: null,
    oauthClientSecretEnc: null,
    oauthTokenEndpoint: null,
    oauthTokenEndpointAuth: null,
    status: "connected",
    toolCache: null,
    updatedAt: new Date(),
    url: "https://mcp.example.com/mcp",
    vaultCredentialId: "cred_1",
    vaultId: "vault_1",
    ...overrides,
  }) as Connector;

describe("connectorServerName", () => {
  test("comes from the id alone, so a rename cannot move it", () => {
    const before = connector({ name: "Linear" });
    const after = connector({ name: "Linear (work)" });

    expect(connectorServerName(before)).toBe(
      "connector_11111111222233334444555555555555"
    );
    expect(connectorServerName(after)).toBe(connectorServerName(before));
  });

  test("is unique per connector", () => {
    expect(connectorServerName({ id: "a" })).not.toBe(
      connectorServerName({ id: "b" })
    );
  });
});

describe("isConnectorUsable", () => {
  test("an authorized connector is attached", () => {
    expect(isConnectorUsable(connector())).toBe(true);
  });

  test("a disabled connector is not, however good its credential", () => {
    expect(isConnectorUsable(connector({ status: "disabled" }))).toBe(false);
  });

  test("an unconfigured connector is not", () => {
    expect(isConnectorUsable(connector({ status: "unconfigured" }))).toBe(
      false
    );
  });

  test("a re-authorization in flight keeps the credential it has", () => {
    // The vault credential is only replaced when the callback lands, so the
    // connector never leaves the agent's servers on the way through the popup -
    // which is what keeps a re-auth from rotating the agent's token twice.
    expect(isConnectorUsable(connector({ status: "authorizing" }))).toBe(true);
    expect(
      isConnectorUsable(
        connector({ status: "authorizing", vaultCredentialId: null })
      )
    ).toBe(false);
  });

  test("auth_error still attaches when a vault credential exists", () => {
    // Anthropic holds the credential and retries it on the next idle-to-running
    // transition, so the connector may simply recover inside the session.
    expect(isConnectorUsable(connector({ status: "auth_error" }))).toBe(true);
  });

  test("auth_error without a credential is left off", () => {
    expect(
      isConnectorUsable(
        connector({
          status: "auth_error",
          vaultCredentialId: null,
          vaultId: null,
        })
      )
    ).toBe(false);
  });

  test("an authorized connector with no credential yet is left off", () => {
    expect(
      isConnectorUsable(connector({ vaultCredentialId: null, vaultId: null }))
    ).toBe(false);
  });

  test("a server that wants no auth needs no credential", () => {
    expect(
      isConnectorUsable(
        connector({
          authKind: "none",
          vaultCredentialId: null,
          vaultId: null,
        })
      )
    ).toBe(true);
  });

  test("but one that started refusing us has nothing to retry with", () => {
    expect(
      isConnectorUsable(
        connector({
          authKind: "none",
          status: "auth_error",
          vaultCredentialId: null,
          vaultId: null,
        })
      )
    ).toBe(false);
  });
});
