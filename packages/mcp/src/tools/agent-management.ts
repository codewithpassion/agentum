import { z } from "zod";
import type { AdminPort } from "../ports";
import {
  defineTool,
  READ_ONLY,
  type ToolDefinition,
  WRITE_UPDATE,
} from "./define";

const agent = z
  .string()
  .min(1)
  .max(200)
  .describe(
    "An agent slug or id, as list_agents returns. Archived agents can be referenced too."
  );
const local = z
  .string()
  .min(1)
  .max(40)
  .describe("The email local part, without @ or the domain.");
const userId = z.string().min(1).max(200).nullable().optional();

export const agentManagementReadTools = (port: AdminPort): ToolDefinition[] => [
  defineTool({
    annotations: READ_ONLY,
    description:
      "Reads an agent's configuration, machine, instructions, connector and skill assignments, owner and backup Clerk user ids, ask-before settings, reserved email address and local part and timestamps. Includes archived agents. Never returns secret values. updatedAt is the latest recorded configuration change.",
    inputSchema: z.strictObject({ agent }),
    name: "get_agent",
    run: async (input) => {
      const detail = await port.getAgent(input);
      return {
        data: { agent: detail },
        text: `Agent "${detail.name}" (${detail.slug}, ${detail.id}) is ${detail.status}.`,
      };
    },
    title: "Get agent",
  }),
];

export const agentManagementWriteTools = (
  port: AdminPort
): ToolDefinition[] => [
  defineTool({
    annotations: WRITE_UPDATE,
    description:
      "Archives an agent without deleting it. It can be restored with restore_agent.",
    inputSchema: z.strictObject({ agent }),
    name: "archive_agent",
    run: async (input) => ({
      data: { agent: await port.archiveAgent(input) },
      text: "Agent archived. Use restore_agent to restore it.",
    }),
    title: "Archive agent",
  }),
  defineTool({
    annotations: WRITE_UPDATE,
    description:
      "Restores an archived agent to active. Refuses if its slug or address is now taken by another active agent.",
    inputSchema: z.strictObject({ agent }),
    name: "restore_agent",
    run: async (input) => ({
      data: { agent: await port.restoreAgent(input) },
      text: "Agent restored to active.",
    }),
    title: "Restore agent",
  }),
  defineTool({
    annotations: WRITE_UPDATE,
    description:
      "Sets the agent's owner and backup using Clerk user ids. Omitted fields stay unchanged; null clears a field (a cleared owner falls back to the creator). There is no members MCP tool: get_agent shows current owner, backup and creator ids; obtain other member ids from your workspace administrator. Both people must be current workspace members and different people.",
    inputSchema: z.strictObject({
      agent,
      backupUserId: userId,
      ownerUserId: userId,
    }),
    name: "set_agent_owners",
    run: async (input) => ({
      data: { agent: await port.setAgentOwners(input) },
      text: "Agent owners updated.",
    }),
    title: "Set agent owners",
  }),
  defineTool({
    annotations: WRITE_UPDATE,
    description:
      "Changes one Ask me before it action, using the same action and ask fields as the agent profile. get_agent lists available action keys and current settings.",
    inputSchema: z.strictObject({
      action: z.string().min(1).max(200),
      agent,
      ask: z.boolean(),
    }),
    name: "set_agent_ask_before",
    run: async (input) => {
      await port.setAgentAskBefore(input);
      return {
        data: { updated: true },
        text: "Agent ask-before setting updated.",
      };
    },
    title: "Set agent ask before",
  }),
  defineTool({
    annotations: READ_ONLY,
    description:
      "Checks whether an agent email local part is available. Requires a write connection; returns availability only, never the address owner.",
    inputSchema: z.strictObject({ local }),
    name: "check_agent_address",
    run: async (input) => {
      const result = await port.checkAgentAddress(input);
      return {
        data: result,
        text: result.available ? "Address available." : "Address taken.",
      };
    },
    title: "Check agent address",
  }),
  defineTool({
    annotations: WRITE_UPDATE,
    description:
      "Reserves an email local part for an agent using the same rules as the app. Refuses reserved or taken addresses.",
    inputSchema: z.strictObject({ agent, local }),
    name: "reserve_agent_address",
    run: async (input) => ({
      data: { agent: await port.reserveAgentAddress(input) },
      text: "Agent address reserved.",
    }),
    title: "Reserve agent address",
  }),
];
