import { z } from "zod";
import type { AdminPort } from "../ports";
import { ToolError } from "../result";
import {
  defineTool,
  type ToolDefinition,
  WRITE_CREATE,
  WRITE_DELETE,
  WRITE_UPDATE,
} from "./define";

const ref = z
  .string()
  .min(1)
  .max(200)
  .describe("An id, as the tool that made it returns.");

const agentRef = z
  .string()
  .min(1)
  .max(200)
  .describe("An agent slug or id, as list_agents returns.");

const name = z.string().trim().min(1).max(200);

const model = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe("The model id the agent runs on.");

const slug = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe("A URL-safe name for the agent, used to @mention it in the inbox.");

const machineId = z
  .string()
  .min(1)
  .max(200)
  .describe("The id of the enrolled machine the agent runs on.");

const connectors = z
  .array(z.string().min(1).max(200))
  .describe("Connector ids the agent may use.");

const instructions = z
  .string()
  .trim()
  .min(1)
  .max(100_000)
  .describe("The standing instructions the agent follows on every run.");

const environment = z
  .enum(["isolate", "linux-vm"])
  .describe(
    "Where a cloud agent's code runs: an isolate, or a Linux virtual machine."
  );

const networkAccess = z
  .boolean()
  .describe("Whether the agent's runs may reach the network.");

const maxTurns = z
  .int()
  .min(1)
  .describe("The most turns one run of the agent may take.");

const secretRule = z.strictObject({
  header: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("The request header to set, such as Authorization."),
  host: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .describe("The host the rule applies to, such as api.example.com."),
  template: z
    .string()
    .min(1)
    .max(1000)
    .describe(
      "The header value. Write {value} where the secret goes, such as Bearer {value}."
    ),
});

/**
 * One tool takes both secret modes: the MCP SDK's input schema does not take
 * a discriminated union, so `run` checks which fields each mode needs.
 */
const secretInput = z.strictObject({
  allowedHosts: z
    .array(z.string().trim().min(1).max(253))
    .optional()
    .describe("For env mode: the hosts the secret may be sent to."),
  mode: z
    .enum(["env", "proxy"])
    .describe(
      "env puts the value in the agent's environment. proxy keeps the value out of the agent: the proxy sets the headers in rules."
    ),
  name,
  rules: z
    .array(secretRule)
    .optional()
    .describe("For proxy mode: the header rules, at least one."),
  value: z
    .string()
    .min(1)
    .describe(
      "The secret value. It is stored and never returned, so no tool result repeats it."
    ),
});

type SecretInput = z.output<typeof secretInput>;

/** Checks that each mode has the fields it needs, and builds the port's input from them. */
const toSecretPortInput = (
  input: SecretInput
): Parameters<AdminPort["createSecret"]>[0] => {
  if (input.mode === "env") {
    if (input.rules !== undefined) {
      throw new ToolError(
        "validation",
        "An env secret takes no rules. Use mode proxy to set headers."
      );
    }
    return {
      allowedHosts: input.allowedHosts,
      mode: "env",
      name: input.name,
      value: input.value,
    };
  }
  if (input.rules === undefined || input.rules.length === 0) {
    throw new ToolError(
      "validation",
      "A proxy secret needs at least one rule in rules."
    );
  }
  if (input.allowedHosts !== undefined) {
    throw new ToolError(
      "validation",
      "A proxy secret takes its hosts from its rules. Drop allowedHosts."
    );
  }
  return {
    mode: "proxy",
    name: input.name,
    rules: input.rules,
    value: input.value,
  };
};

const agentSettings = {
  connectors: connectors.optional(),
  environment: environment.optional(),
  instructions: instructions.optional(),
  maxTurns: maxTurns.optional(),
  networkAccess: networkAccess.optional(),
};

/** Tools that create or change records for a write key. */
export const adminWriteTools = (port: AdminPort): ToolDefinition[] => [
  defineTool({
    annotations: WRITE_CREATE,
    description:
      "Creates an agent in the workspace. Returns the new agent's id and slug; use the slug to @mention it in the inbox. runtime is cloud, machine (pass machineId) or managed.",
    inputSchema: z.strictObject({
      ...agentSettings,
      machineId: machineId.optional(),
      model,
      name,
      runtime: z
        .enum(["cloud", "machine", "managed"])
        .describe("Where the agent runs: cloud, machine or managed."),
      slug: slug.optional(),
    }),
    name: "create_agent",
    run: async (input) => {
      const agent = await port.createAgent(input);
      return {
        data: { agent },
        text: `Created agent "${agent.name}" (${agent.slug}, ${agent.id}) on ${agent.runtime} with model ${agent.model}.`,
      };
    },
    title: "Create agent",
  }),
  defineTool({
    annotations: WRITE_UPDATE,
    description:
      "Changes an existing agent. Pass only the fields to change; the others stay as they are. Returns the agent as it is afterwards. Use list_agents to find the agent. The runtime cannot change.",
    inputSchema: z.strictObject({
      ...agentSettings,
      agent: agentRef,
      machineId: machineId
        .nullable()
        .optional()
        .describe(
          "The machine the agent runs on, or null to detach it from its machine."
        ),
      model: model.optional(),
      name: name.optional(),
      slug: slug.optional(),
    }),
    name: "update_agent",
    run: async (input) => {
      const agent = await port.updateAgent(input);
      return {
        data: { agent },
        text: `Updated agent "${agent.name}" (${agent.slug}, ${agent.id}).`,
      };
    },
    title: "Update agent",
  }),
  defineTool({
    annotations: WRITE_CREATE,
    description:
      "Creates an inbox thread. Returns the thread's id, which inbox_post and inbox_read accept.",
    inputSchema: z.strictObject({
      title: name.describe("A short title for the thread."),
    }),
    name: "create_inbox_thread",
    run: async (input) => {
      const thread = await port.createInboxThread(input);
      return {
        data: { thread },
        text: `Created inbox thread ${thread.id}: ${thread.title}`,
      };
    },
    title: "Create inbox thread",
  }),
];

/** Tools that store secrets, grant them, and mint or revoke API keys and enrolment codes. Admin keys only. */
export const adminSetupTools = (port: AdminPort): ToolDefinition[] => [
  defineTool({
    annotations: WRITE_CREATE,
    description:
      "Stores a secret for agents to use. The value is write-only: the result gives the secret's id, name, mode and hosts, never the value. env mode puts the value in the agent's environment and may take allowedHosts. proxy mode keeps the value away from the agent: each rule sets one header on requests to its host, with {value} in the template where the secret goes.",
    inputSchema: secretInput,
    name: "create_secret",
    run: async (input) => {
      const secret = await port.createSecret(toSecretPortInput(input));
      return {
        data: { secret },
        text: `Created ${secret.mode} secret "${secret.name}" (${secret.id}). Hosts: ${secret.hosts.join(", ") || "none"}.`,
      };
    },
    title: "Create secret",
  }),
  defineTool({
    annotations: WRITE_UPDATE,
    description:
      "Lets an agent use a secret made by create_secret. Repeating it changes nothing. Returns the agent and secret ids it was given.",
    inputSchema: z.strictObject({ agent: agentRef, secretId: ref }),
    name: "grant_secret",
    run: async (input) => {
      await port.grantSecret(input);
      return {
        data: { agent: input.agent, secretId: input.secretId },
        text: `Granted secret ${input.secretId} to ${input.agent}.`,
      };
    },
    title: "Grant secret",
  }),
  defineTool({
    annotations: WRITE_DELETE,
    description:
      "Stops an agent from using a secret. The secret itself stays in the workspace. Repeating it changes nothing.",
    inputSchema: z.strictObject({ agent: agentRef, secretId: ref }),
    name: "revoke_secret",
    run: async (input) => {
      await port.revokeSecret(input);
      return {
        data: { agent: input.agent, secretId: input.secretId },
        text: `Revoked secret ${input.secretId} from ${input.agent}.`,
      };
    },
    title: "Revoke secret",
  }),
  defineTool({
    annotations: WRITE_CREATE,
    description:
      "Makes a one-time enrolment code that enrols a machine or computer with Agentum. The result carries the code and its expiry, and the code is shown once: it cannot be read again, so pass it on at once. role is agent_host or computer. machineName names a new machine; machineId points at an existing one.",
    inputSchema: z.strictObject({
      machineId: machineId.optional(),
      machineName: name.optional(),
      role: z
        .enum(["agent_host", "computer"])
        .optional()
        .describe("What the enrolled machine does: agent_host or computer."),
    }),
    name: "create_enrolment_code",
    run: async (input) => {
      const enrolment = await port.createEnrolmentCode(input);
      return {
        data: enrolment,
        text: `Enrolment code ${enrolment.code}, expires ${enrolment.expiresAt}. The code is shown once: pass it on now, it cannot be read again.`,
      };
    },
    title: "Create enrolment code",
  }),
  defineTool({
    annotations: WRITE_CREATE,
    description:
      "Makes an API key with the given access: read, write, desk or admin. The result carries the key's secret, and the secret is shown once: it cannot be read again, so pass it on at once.",
    inputSchema: z.strictObject({
      access: z
        .enum(["read", "write", "desk", "admin"])
        .describe("What the key may do: read, write, desk or admin."),
      name,
    }),
    name: "create_api_key",
    run: async (input) => {
      const key = await port.createApiKey(input);
      return {
        data: { key },
        text: `Created ${key.access} API key "${key.name}" (${key.id}, prefix ${key.prefix}). Its secret is ${key.secret}. The secret is shown once: store it now, it cannot be read again.`,
      };
    },
    title: "Create API key",
  }),
  defineTool({
    annotations: WRITE_DELETE,
    description:
      "Revokes an API key, so it no longer works. Returns the key's id, name and revocation time. Repeating it changes nothing.",
    inputSchema: z.strictObject({ keyId: ref }),
    name: "revoke_api_key",
    run: async (input) => {
      const key = await port.revokeApiKey(input);
      return {
        data: { key },
        text: `Revoked API key "${key.name}" (${key.id}).`,
      };
    },
    title: "Revoke API key",
  }),
  defineTool({
    annotations: WRITE_DELETE,
    description:
      "Deletes a connector with its stored credentials and its assignments to agents. Needs an admin API key.",
    inputSchema: z.strictObject({ connectorId: ref }),
    name: "delete_connector",
    run: async (input) => {
      await port.deleteConnector(input);
      return {
        data: { connectorId: input.connectorId },
        text: `Deleted connector ${input.connectorId}.`,
      };
    },
    title: "Delete connector",
  }),
];
