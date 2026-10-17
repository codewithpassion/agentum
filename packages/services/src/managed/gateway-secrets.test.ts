import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { createManagedGateway } from "./gateway.ts";

/** The SDK is faked down to the one call the method makes. */
const client = (credentials: unknown[]): Anthropic =>
  ({
    beta: {
      vaults: {
        credentials: {
          create: (vaultId: string, params: unknown) => {
            credentials.push({ params, vaultId });
            return Promise.resolve({ id: "cred_env" });
          },
        },
      },
    },
  }) as unknown as Anthropic;

const gatewayWith = (credentials: unknown[]) =>
  createManagedGateway(client(credentials), {
    cache: {
      read: () => Promise.resolve("env_1"),
      write: () => Promise.resolve(),
    },
    environmentName: "test",
  });

describe("createEnvironmentVariableCredential", () => {
  test("an unrestricted secret is substituted in the header and the body of any host", async () => {
    const credentials: unknown[] = [];
    const id = await gatewayWith(
      credentials
    ).createEnvironmentVariableCredential({
      name: "PLAIN_KEY",
      value: "plain-value-0123",
      vaultId: "vlt_1",
    });

    expect(id).toBe("cred_env");
    expect(credentials).toEqual([
      {
        params: {
          auth: {
            injection_location: { body: true, header: true },
            networking: { type: "unrestricted" },
            secret_name: "PLAIN_KEY",
            secret_value: "plain-value-0123",
            type: "environment_variable",
          },
          display_name: "PLAIN_KEY",
        },
        vaultId: "vlt_1",
      },
    ]);
  });

  test("a relay token is substituted in the header only, on the hosts it is given", async () => {
    const credentials: unknown[] = [];
    await gatewayWith(credentials).createEnvironmentVariableCredential({
      hosts: ["hm.example"],
      name: "HARBOURMASTER_RELAY_TOKEN",
      value: "hm_ses_test",
      vaultId: "vlt_1",
    });

    expect(credentials).toEqual([
      {
        params: {
          auth: {
            injection_location: { body: false, header: true },
            networking: {
              allowed_hosts: ["hm.example"],
              type: "limited",
            },
            secret_name: "HARBOURMASTER_RELAY_TOKEN",
            secret_value: "hm_ses_test",
            type: "environment_variable",
          },
          display_name: "HARBOURMASTER_RELAY_TOKEN",
        },
        vaultId: "vlt_1",
      },
    ]);
  });
});
