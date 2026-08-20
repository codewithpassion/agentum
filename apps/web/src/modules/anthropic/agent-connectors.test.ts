import { describe, expect, test } from "bun:test";
import type { Connector } from "#/modules/connectors/schema";
import { MAX_AGENT_CONNECTORS } from "#/modules/connectors/usability";
import { composeAgentConnectors } from "./agent-connectors";

const connector = (overrides: Partial<Connector> & { id: string }): Connector =>
  ({
    authKind: "oauth",
    name: overrides.id,
    status: "connected",
    url: `https://${overrides.id}.example.com/mcp`,
    vaultCredentialId: `cred_${overrides.id}`,
    vaultId: `vault_${overrides.id}`,
    ...overrides,
  }) as Connector;

describe("composeAgentConnectors", () => {
  test("declares one server per usable connector, named from its id", () => {
    const composed = composeAgentConnectors([
      connector({ id: "aaaa" }),
      connector({ id: "bbbb" }),
    ]);

    expect(composed.servers).toEqual([
      { name: "connector_aaaa", url: "https://aaaa.example.com/mcp" },
      { name: "connector_bbbb", url: "https://bbbb.example.com/mcp" },
    ]);
    expect(composed.dropped).toEqual([]);
  });

  test("hands session create the vaults of exactly those servers", () => {
    const composed = composeAgentConnectors([
      connector({ id: "aaaa" }),
      connector({ authKind: "none", id: "bbbb", vaultId: null }),
      connector({ id: "cccc", status: "disabled" }),
    ]);

    expect(composed.vaultIds).toEqual(["vault_aaaa"]);
  });

  test("dedupes vault ids", () => {
    const composed = composeAgentConnectors([
      connector({ id: "aaaa", vaultId: "vault_shared" }),
      connector({ id: "bbbb", vaultId: "vault_shared" }),
    ]);

    expect(composed.vaultIds).toEqual(["vault_shared"]);
  });

  test("skips disabled connectors and ones that never got a credential", () => {
    const composed = composeAgentConnectors([
      connector({ id: "off", status: "disabled" }),
      connector({ id: "never", status: "auth_error", vaultCredentialId: null }),
      connector({ id: "pending", status: "unconfigured" }),
    ]);

    expect(composed.servers).toEqual([]);
    expect(composed.vaultIds).toEqual([]);
  });

  test("keeps an authorized connector that is currently in auth_error", () => {
    // Its credential is in the vault and Anthropic retries it, so the session
    // may well recover - the plan is explicit that it must not block start-up.
    const composed = composeAgentConnectors([
      connector({ id: "flaky", status: "auth_error" }),
    ]);

    expect(composed.servers.map((server) => server.name)).toEqual([
      "connector_flaky",
    ]);
    expect(composed.vaultIds).toEqual(["vault_flaky"]);
  });

  test("clamps at the cap and reports what it left off", () => {
    const many = Array.from({ length: MAX_AGENT_CONNECTORS + 2 }, (_, index) =>
      connector({ id: `c${index}` })
    );

    const composed = composeAgentConnectors(many);

    // 20 `mcp_servers` per agent, and the workspace server always takes one.
    expect(composed.servers).toHaveLength(MAX_AGENT_CONNECTORS);
    expect(composed.dropped.map((entry) => entry.id)).toEqual([
      `c${MAX_AGENT_CONNECTORS}`,
      `c${MAX_AGENT_CONNECTORS + 1}`,
    ]);
  });
});
