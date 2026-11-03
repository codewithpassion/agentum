import { z } from "zod";
import type { McpPorts, TriggerChange, TriggerInfo } from "../ports";
import {
  defineTool,
  READ_ONLY,
  type ToolDefinition,
  WRITE_CREATE,
  WRITE_DELETE,
  WRITE_UPDATE,
} from "./define";

const agentId = z
  .string()
  .min(1)
  .max(200)
  .describe("An agent id or slug, as list_agents returns.");

const triggerId = z
  .string()
  .min(1)
  .max(200)
  .describe("A trigger id, as list_triggers returns.");

const APPROVAL =
  "It is stored off and waits for a person to approve it in the Agentum UI (Triggers page).";

/** A trigger's line. It carries no secret or token prefix: those show only where the tool says so. */
const triggerLine = (trigger: TriggerInfo): string => {
  const line = `${trigger.id} ${trigger.status} "${trigger.name}" for ${trigger.agentName}`;
  return trigger.status === "awaiting_approval" ? `${line}\n${APPROVAL}` : line;
};

/** The line for a trigger that was just created or switched on, with its secret when there is one. */
const changeText = ({ secret, trigger }: TriggerChange): string =>
  secret === null
    ? triggerLine(trigger)
    : `${triggerLine(trigger)}\nSecret (shown once, store it now): ${secret}`;

/** The data for a changed trigger: `secret` appears only when there is one to show. */
const changeData = ({ secret, trigger }: TriggerChange): object =>
  secret === null ? { trigger } : { secret, trigger };

export const triggerTools = (ports: McpPorts): ToolDefinition[] => [
  defineTool({
    annotations: READ_ONLY,
    description:
      "Lists the workspace's HTTP triggers, which let an outside system start an agent with a secret. Each shows its status and the start of its secret, which tells triggers apart; the secret itself is never listed. Pass agentId to list only one agent's triggers. Use the returned trigger ids with set_trigger_enabled and delete_trigger.",
    inputSchema: z.strictObject({
      agentId: agentId.optional(),
    }),
    name: "list_triggers",
    run: async (input) => {
      const triggers = await ports.listTriggers(input);
      return {
        data: { triggers },
        text:
          triggers
            .map((trigger) =>
              trigger.tokenPrefix === ""
                ? triggerLine(trigger)
                : `${triggerLine(trigger)} token ${trigger.tokenPrefix}...`
            )
            .join("\n") || "No triggers.",
      };
    },
    title: "List triggers",
  }),
  defineTool({
    annotations: WRITE_CREATE,
    description:
      "Creates an HTTP trigger that starts an agent when an outside system calls it with the trigger's secret. The secret is shown once, in this result, so the caller must store it now. When an agent calls this, the result is a proposal that stays off until a person approves it in the Agentum UI. An agent cannot enable anything.",
    inputSchema: z.strictObject({
      agentId,
      name: z
        .string()
        .trim()
        .min(1)
        .max(80)
        .describe("A short name for the trigger."),
    }),
    name: "create_trigger",
    run: async (input) => {
      const change = await ports.createTrigger(input);
      return {
        data: changeData(change),
        text: changeText(change),
      };
    },
    title: "Create trigger",
  }),
  defineTool({
    annotations: WRITE_UPDATE,
    description:
      "Switches a trigger on or off. Setting enabled to true turns on a trigger that is off, or approves one that is awaiting approval. An agent can only switch its own agent's triggers off: it cannot enable anything, and its proposals wait for a person to approve them in the Agentum UI.",
    inputSchema: z.strictObject({
      enabled: z
        .boolean()
        .describe("true to switch the trigger on, false to pause it."),
      triggerId,
    }),
    name: "set_trigger_enabled",
    run: async (input) => {
      const change = await ports.setTriggerEnabled(input);
      return {
        data: changeData(change),
        text: changeText(change),
      };
    },
    title: "Enable or pause trigger",
  }),
  defineTool({
    annotations: WRITE_DELETE,
    description:
      "Removes a trigger, so outside calls with its secret no longer start an agent. An agent can remove only the triggers it proposed.",
    inputSchema: z.strictObject({ triggerId }),
    name: "delete_trigger",
    run: async (input) => {
      await ports.deleteTrigger(input);
      return {
        data: { deleted: input.triggerId },
        text: `Deleted trigger ${input.triggerId}.`,
      };
    },
    title: "Delete trigger",
  }),
];
