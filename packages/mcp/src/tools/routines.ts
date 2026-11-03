import { z } from "zod";
import type { McpPorts, RoutineInfo } from "../ports";
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

const routineId = z
  .string()
  .min(1)
  .max(200)
  .describe("A routine id, as list_routines returns.");

const APPROVAL =
  "It is stored off and waits for a person to approve it in the Agentum UI (Routines page).";

const routineLine = (routine: RoutineInfo): string => {
  const line = `${routine.id} ${routine.status} "${routine.name}" for ${routine.agentName}: cron "${routine.cron}" in ${routine.timezone}`;
  return routine.status === "awaiting_approval" ? `${line}\n${APPROVAL}` : line;
};

export const routineTools = (ports: McpPorts): ToolDefinition[] => [
  defineTool({
    annotations: READ_ONLY,
    description:
      "Lists the workspace's routines, which are agents started on a cron schedule, with their status and next run time. Pass agentId to list only one agent's routines. Use the returned routine ids with set_routine_enabled and delete_routine.",
    inputSchema: z.strictObject({
      agentId: agentId.optional(),
    }),
    name: "list_routines",
    run: async (input) => {
      const routines = await ports.listRoutines(input);
      return {
        data: { routines },
        text: routines.map(routineLine).join("\n") || "No routines.",
      };
    },
    title: "List routines",
  }),
  defineTool({
    annotations: WRITE_CREATE,
    description:
      "Creates a routine that starts an agent on a cron schedule. The cron is five fields read in the given timezone: '0 9 * * 1-5' is 09:00 on weekdays, '*/15 * * * *' is every 15 minutes. When an agent calls this, the result is a proposal that stays off until a person approves it in the Agentum UI. An agent cannot enable anything.",
    inputSchema: z.strictObject({
      agentId,
      cron: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .describe("A five-field cron expression, read in the timezone."),
      name: z
        .string()
        .trim()
        .min(1)
        .max(80)
        .describe("A short name for the routine."),
      prompt: z
        .string()
        .trim()
        .min(1)
        .max(100_000)
        .describe("What the agent is asked to do on each run."),
      timezone: z
        .string()
        .trim()
        .min(1)
        .max(64)
        .optional()
        .describe(
          "An IANA timezone, such as Europe/Zurich. The cron is read in it."
        ),
    }),
    name: "create_routine",
    run: async (input) => {
      const routine = await ports.createRoutine(input);
      return {
        data: { routine },
        text: routineLine(routine),
      };
    },
    title: "Create routine",
  }),
  defineTool({
    annotations: WRITE_UPDATE,
    description:
      "Switches a routine on or off. Setting enabled to true turns on a routine that is off, or approves one that is awaiting approval. An agent can only switch its own agent's routines off: it cannot enable anything, and its proposals wait for a person to approve them in the Agentum UI.",
    inputSchema: z.strictObject({
      enabled: z
        .boolean()
        .describe("true to switch the routine on, false to pause it."),
      routineId,
    }),
    name: "set_routine_enabled",
    run: async (input) => {
      const routine = await ports.setRoutineEnabled(input);
      return {
        data: { routine },
        text: routineLine(routine),
      };
    },
    title: "Enable or pause routine",
  }),
  defineTool({
    annotations: WRITE_DELETE,
    description:
      "Removes a routine, so it no longer fires. An agent can remove only the routines it proposed.",
    inputSchema: z.strictObject({ routineId }),
    name: "delete_routine",
    run: async (input) => {
      await ports.deleteRoutine(input);
      return {
        data: { deleted: input.routineId },
        text: `Deleted routine ${input.routineId}.`,
      };
    },
    title: "Delete routine",
  }),
];
